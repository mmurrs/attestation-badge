// Framework-free verification core. The React badge is only a renderer over this.
//
// Chain of custody the badge walks, and where each fact comes from:
//   SOURCE  — the pinned GitHub permalink; the highlighted lines are fetched from
//             raw.githubusercontent.com (GitHub's CDN, CORS-open), never from the app.
//   BUILD   — SLSA provenance (in-toto DSSE) from the EigenCompute public build API:
//             git commit  ->  image digest, built by Google Cloud Build.
//   RELEASE — the AppUpgraded event on the AppController contract, read from a public
//             Ethereum RPC in *your* browser: image digest recorded on-chain for this app.
//   RUNTIME — a fresh attestation quote fetched from the app with a caller nonce
//             (only possible when the app opts in by proxying its in-TEE socket).
//
// The only leg that trusts the app being verified is RUNTIME. SOURCE, BUILD and
// RELEASE come from GitHub, the build API and the chain respectively.

import { decodeEventLog } from 'viem';
import {
  ENVIRONMENTS,
  APP_UPGRADED_V15,
  APP_UPGRADED_V14,
  GET_LATEST_RELEASE_BLOCK_SELECTOR,
} from './abi.js';
import { verifyAttestationToken, TOKEN_AUDIENCE } from './token.js';

export function parsePermalink(url) {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\/(.+?)(#L(\d+)(?:-L(\d+))?)?$/
  );
  if (!m) {
    throw new Error(
      'Permalink must pin a full 40-char commit: https://github.com/owner/repo/blob/<sha>/<path>#L1-L2'
    );
  }
  return {
    owner: m[1],
    repo: m[2],
    commit: m[3],
    path: m[4],
    lineStart: m[6] ? Number(m[6]) : null,
    lineEnd: m[7] ? Number(m[7]) : m[6] ? Number(m[6]) : null,
    url,
  };
}

// Auto mode: no pinned sha — the commit comes from the running build's provenance,
// so the badge always shows "the lines as they exist in whatever is running".
// Strict mode (a full permalink) additionally asserts the running commit IS that sha.
export function resolveSource({ permalink, source }, provenance) {
  if (permalink) return { link: parsePermalink(permalink), mode: 'pinned' };
  if (!source?.file) throw new Error('Pass either `permalink` or `source: {file, lines}`');
  if (!provenance?.repoUrl || !provenance?.commit) return { link: null, mode: 'auto' };
  const m = provenance.repoUrl.replace(/\.git$/, '').match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!m) return { link: null, mode: 'auto' };
  const [lineStart, lineEnd] = source.lines ?? [null, null];
  const frag = lineStart ? `#L${lineStart}${lineEnd ? `-L${lineEnd}` : ''}` : '';
  return {
    mode: 'auto',
    link: {
      owner: m[1],
      repo: m[2],
      commit: provenance.commit,
      path: source.file,
      lineStart,
      lineEnd: lineEnd ?? lineStart,
      url: `https://github.com/${m[1]}/${m[2]}/blob/${provenance.commit}/${source.file}${frag}`,
    },
  };
}

async function rpcOnce(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

// Try each RPC in order. `unacceptable` lets the caller reject answers that
// are well-formed but impossible (free RPCs return [] instead of erroring
// when they haven't indexed a block).
async function rpc(rpcUrls, method, params, unacceptable = () => false) {
  let lastErr;
  for (const url of rpcUrls) {
    try {
      const result = await rpcOnce(url, method, params);
      if (unacceptable(result)) {
        lastErr = new Error(`${new URL(url).host} returned an implausible empty result`);
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('no RPC configured');
}

// RELEASE — read the app's current release straight off the chain.
export async function fetchOnchainRelease({ appAddress, environment }) {
  const env = ENVIRONMENTS[environment];
  if (!env) throw new Error(`Unknown environment: ${environment}`);
  const app = appAddress.toLowerCase().replace(/^0x/, '');

  const blockHex = await rpc(env.rpcs, 'eth_call', [
    { to: env.appController, data: GET_LATEST_RELEASE_BLOCK_SELECTOR + app.padStart(64, '0') },
    'latest',
  ]);
  const block = parseInt(blockHex, 16);
  if (!block) throw new Error('App has no confirmed release on this AppController');

  const blockTag = '0x' + block.toString(16);
  // The contract just told us a release was confirmed at `block`, so an
  // empty log set is an unindexed/lying RPC, not an answer.
  const logs = await rpc(
    env.rpcs,
    'eth_getLogs',
    [
      {
        address: env.appController,
        topics: [null, '0x' + app.padStart(64, '0')],
        fromBlock: blockTag,
        toBlock: blockTag,
      },
    ],
    (r) => !Array.isArray(r) || r.length === 0
  );

  for (const log of logs) {
    for (const abi of [APP_UPGRADED_V15, APP_UPGRADED_V14]) {
      try {
        const { args } = decodeEventLog({ abi: [abi], data: log.data, topics: log.topics });
        const artifact = args.release.rmsRelease.artifacts[0];
        return {
          digest: 'sha256:' + artifact.digest.slice(2),
          registry: artifact.registry,
          rmsReleaseId: args.rmsReleaseId.toString(),
          block,
          txHash: log.transactionHash,
          txUrl: env.explorerTx + log.transactionHash,
          appController: env.appController,
        };
      } catch {
        // not this ABI version; try the next
      }
    }
  }
  throw new Error(`No AppUpgraded event for app at block ${block}`);
}

// BUILD — public provenance API. `buildApiBase` defaults to the same-origin proxy
// (/attest/provenance) because userapi CORS only allows the official dashboards.
// The proxy needs to know which network's userapi to ask, hence ?env=.
export async function fetchProvenance({ digest, buildApiBase, environment }) {
  const sep = buildApiBase.includes('?') ? '&' : '?';
  const url = buildApiBase.startsWith('/')
    ? `${buildApiBase}/${digest}${sep}env=${environment}`
    : `${buildApiBase}/${digest}`;
  const res = await fetch(url);
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) throw new Error(`Build API ${res.status}`);
  const p = await res.json();

  // Client-side consistency check on the DSSE envelope: decode the signed
  // payload ourselves and require that the convenience fields (image digest,
  // commit) match what's actually inside it. The signature itself can't be
  // checked until the platform publishes the signer key, but this stops an
  // API that says "verified" while shipping mismatched provenance.
  let dsseConsistent = false;
  try {
    const payload = JSON.parse(atob(p.payload));
    const subjDigest = 'sha256:' + payload.subject?.[0]?.digest?.sha256;
    const matCommit = payload.predicate?.materials?.[0]?.digest?.sha1;
    dsseConsistent = subjDigest === p.image_digest && matCommit === p.git_ref;
  } catch {
    dsseConsistent = false;
  }

  const material = p.provenance_json?.predicate?.materials?.[0] ?? {};
  return {
    status: p.status, // the platform's verdict on the DSSE signature
    dsseConsistent, // OUR check: signed payload agrees with the summary fields
    buildId: p.build_id,
    imageDigest: p.image_digest,
    repoUrl: p.repo_url,
    commit: material.digest?.sha1 ?? p.git_ref,
    materialUri: material.uri,
    payloadType: p.payload_type,
    signature: p.provenance_signature,
    builderId: p.provenance_json?.predicate?.builder?.id,
    raw: p,
  };
}

// SOURCE — the highlighted lines, from GitHub's CDN, not from the app.
export async function fetchSourceLines(link) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${link.owner}/${link.repo}/${link.commit}/${link.path}`
  );
  if (!res.ok) {
    throw new Error(
      `GitHub raw fetch ${res.status} — repo not public, or ${link.path} doesn't exist at this commit`
    );
  }
  const lines = (await res.text()).split('\n');
  const start = link.lineStart ?? 1;
  const end = Math.min(link.lineEnd ?? lines.length, lines.length);
  return { lines: lines.slice(start - 1, end), start, end };
}

// RUNTIME fallback — raw quote with nonce echo only (no browser-side crypto).
export async function fetchRuntimeQuote({ appOrigin }) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const res = await fetch(`${appOrigin}/attest/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!res.ok) throw new Error(`quote endpoint ${res.status}`);
  const q = await res.json();
  return { ...q, sentNonce: nonce, nonceEchoed: q.nonce === nonce };
}

// RUNTIME — attestation token with our nonce, verified HERE in the browser:
// RS256 against Google's JWKS (CORS-open), nonce freshness, and image_digest
// bound to the on-chain release. Only possible if the app exposes /attest/token.
export async function fetchRuntimeAttestation({ appOrigin, expectedDigest }) {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const res = await fetch(`${appOrigin}/attest/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, audience: TOKEN_AUDIENCE }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const t = await res.json();
  if (!t.inTee) return { inTee: false, error: t.error };
  const verification = await verifyAttestationToken(t.token, { nonce, expectedDigest });
  return { inTee: true, sentNonce: nonce, verification, token: t.token };
}

/**
 * Walk the whole chain. Returns { verdict, steps: [source, build, release, runtime] }.
 * Each step: { id, title, state: 'verified'|'failed'|'unavailable', detail, links, evidence }.
 *
 * Source selection — one of:
 *   permalink: full GitHub blob URL pinning a 40-char sha  (strict: running commit must equal it)
 *   source:    { file: 'api/inbox.js', lines: [12, 24] }   (auto: commit taken from the running build)
 */
export async function verifyChain({
  permalink,
  source: sourceSpec,
  appAddress,
  environment = 'sepolia',
  appOrigin = '',
  buildApiBase = '/attest/provenance',
}) {
  const env = ENVIRONMENTS[environment];
  const steps = [];

  // RELEASE first: it's the trust root the other legs are compared against.
  let release;
  let releaseError;
  try {
    release = await fetchOnchainRelease({ appAddress, environment });
  } catch (e) {
    releaseError = e.message;
  }

  let provenance;
  if (release) {
    try {
      provenance = await fetchProvenance({ digest: release.digest, buildApiBase, environment });
    } catch (e) {
      provenance = { status: 'error', error: e.message };
    }
  }

  // SOURCE
  const { link, mode } = resolveSource({ permalink, source: sourceSpec }, provenance);
  let source = null;
  if (link) {
    try {
      source = await fetchSourceLines(link);
    } catch (e) {
      source = { error: e.message };
    }
  }
  const commitMatches = mode === 'auto' || provenance?.commit === link?.commit;
  const repoMatches =
    mode === 'auto' ||
    (provenance?.repoUrl &&
      link &&
      provenance.repoUrl.replace(/\.git$/, '').toLowerCase() ===
        `https://github.com/${link.owner}/${link.repo}`.toLowerCase());
  steps.push({
    id: 'source',
    title: mode === 'pinned' ? 'Pinned source' : 'Running source',
    state: !link
      ? 'unavailable'
      : source?.error
        ? 'failed'
        : provenance?.status === 'verified'
          ? commitMatches && repoMatches
            ? 'verified'
            : 'failed'
          : 'unavailable',
    detail: !link
      ? 'No verified build to resolve the source from'
      : source?.error
        ? source.error
        : provenance?.status !== 'verified'
          ? 'Could not compare against a verified build'
          : commitMatches && repoMatches
            ? `Commit ${link.commit.slice(0, 12)} — the lines below come from GitHub, not this app`
            : `Permalink pins ${link.commit.slice(0, 12)} but the running build is from ${String(provenance.commit).slice(0, 12)}`,
    links: link ? [{ label: 'Open on GitHub', href: link.url }] : [],
    evidence: { link, source, mode },
  });

  // BUILD
  steps.push({
    id: 'build',
    title: 'Verifiable build',
    state:
      provenance?.status === 'verified' && provenance.dsseConsistent
        ? 'verified'
        : provenance?.status === 'verified' || provenance?.status === 'not_found'
          ? 'failed'
          : 'unavailable',
    detail:
      provenance?.status === 'verified' && provenance.dsseConsistent
        ? `SLSA provenance: commit ${String(provenance.commit).slice(0, 12)} → image ${provenance.imageDigest.slice(7, 19)}, built by Cloud Build; signed payload decoded and cross-checked in this browser`
        : provenance?.status === 'verified'
          ? 'Provenance summary fields do not match the signed DSSE payload — treat as unverified'
          : provenance?.status === 'not_found'
            ? 'No verifiable build recorded for the on-chain digest — this image was not built from public source'
            : `Build API unreachable (${provenance?.error ?? 'no release digest to look up'})`,
    links: release
      ? [{ label: 'Provenance (DSSE)', href: `${buildApiBase}/${release.digest}` }]
      : [],
    evidence: { provenance },
  });

  // RELEASE
  steps.push(
    release
      ? {
          id: 'release',
          title: 'On-chain release',
          state: 'verified',
          detail: `AppController recorded ${release.digest.slice(7, 19)} for this app (release #${release.rmsReleaseId}) — read from a public RPC in your browser`,
          links: [
            { label: 'Upgrade transaction', href: release.txUrl },
            { label: 'EigenCloud dashboard', href: env.dashboardApp + appAddress },
          ],
          evidence: { release },
        }
      : step('release', 'On-chain release', 'failed', releaseError)
  );

  // RUNTIME — token first (browser-verifiable); raw-quote fallback if the
  // launcher doesn't serve /v1/token (older images), so the leg degrades to
  // "nonce echoed, not browser-verified" instead of disappearing.
  let runtime = null;
  if (appOrigin !== null) {
    try {
      runtime = await fetchRuntimeAttestation({ appOrigin, expectedDigest: release?.digest });
    } catch (e) {
      runtime = { error: e.message };
    }
    if (runtime?.error || (runtime?.inTee === false && runtime.error)) {
      try {
        const q = await fetchRuntimeQuote({ appOrigin });
        if (q.inTee && q.nonceEchoed) {
          runtime = {
            inTee: true,
            fallback: true,
            verification: {
              ok: true,
              checks: [
                {
                  name: 'nonce',
                  ok: true,
                  detail:
                    'raw quote fetched with our fresh nonce (token endpoint unavailable — signature not browser-checked)',
                },
              ],
              claims: null,
            },
          };
        }
      } catch {
        // keep the token error
      }
    }
  }
  const rtOk = runtime?.inTee && runtime.verification?.ok;
  const rtFallback = rtOk && runtime.fallback;
  const rtFailedCheck =
    runtime?.verification && !runtime.verification.ok
      ? runtime.verification.checks.find((c) => !c.ok)
      : null;
  steps.push({
    id: 'runtime',
    title: 'Runtime attestation',
    state: rtOk ? 'verified' : rtFailedCheck ? 'failed' : 'unavailable',
    detail: rtFallback
      ? 'Enclave answered a fresh nonce-bound challenge on the in-TEE socket (raw quote). Token endpoint unavailable, so the signature was NOT checked in this browser — verify the quote offline or on the dashboard'
      : rtOk
        ? 'Google-signed attestation token verified in this browser: signature (WebCrypto vs Google JWKS), our fresh nonce, and running image = on-chain digest'
        : rtFailedCheck
          ? `Token check "${rtFailedCheck.name}" failed: ${rtFailedCheck.detail}`
          : runtime && runtime.inTee === false
            ? 'This instance is not running in a TEE (local/dev mode)'
            : `Attestation endpoint unavailable${runtime?.error ? ` (${runtime.error})` : ''}`,
    links: rtOk
      ? [{ label: 'Raw hardware quote (offline go-tpm-tools check)', href: `${appOrigin}/attest/quote` }]
      : [],
    evidence: runtime?.verification
      ? { checks: runtime.verification.checks, claims: pickClaims(runtime.verification.claims) }
      : { runtime },
    caveat: rtFallback
      ? 'Being able to answer on the teeserver socket at all requires running inside the enclave, but treat this leg as weaker than a browser-verified token.'
      : 'The token roots in Google’s attestation service vouching for the TPM quote. For a hardware-root check that trusts no cloud vendor, download the raw quote and verify offline with go-tpm-tools.',
  });

  const core = steps.filter((s) => s.id !== 'runtime');
  const verdict = core.every((s) => s.state === 'verified')
    ? steps.find((s) => s.id === 'runtime')?.state === 'verified'
      ? 'verified-live'
      : 'verified-build'
    : 'failed';

  return { verdict, steps, link, release, provenance };
}

function step(id, title, state, detail) {
  return { id, title, state, detail, links: [], evidence: {} };
}

function pickClaims(claims) {
  if (!claims) return null;
  const { iss, aud, exp, hwmodel, swname, secboot, dbgstat, eat_nonce, submods } = claims;
  return {
    iss,
    aud,
    exp,
    hwmodel,
    swname,
    secboot,
    dbgstat,
    eat_nonce,
    image: submods?.container?.image_reference,
    image_digest: submods?.container?.image_digest,
  };
}
