// The app's opt-in attestation surface — the piece that upgrades the badge
// from "verified build" to "verified live".
//
// Two routes:
//   POST /attest/quote       — fresh TEE quote bound to the caller's nonce.
//                              Proxies the in-VM teeserver socket
//                              (/run/container_launcher/teeserver.sock, the
//                              same primitive the ecloud SDK's AttestClient
//                              uses). Only code inside the enclave can reach
//                              that socket, so being able to answer at all is
//                              the point.
//   GET  /attest/provenance/:digest — same-origin proxy of the public
//                              EigenCompute build API. Needed because userapi
//                              CORS only allows the official dashboards; the
//                              response is client-verifiable DSSE either way,
//                              so proxying does not add trust in this app.

import http from 'node:http';
import crypto from 'node:crypto';

const TEE_SOCKET = process.env.TEE_SOCKET ?? '/run/container_launcher/teeserver.sock';

// Upstream allowlist: the client says which environment it's verifying against,
// but only EigenCloud userapis are proxyable — this route must not become an
// open proxy.
const USER_APIS = {
  'sepolia-dev': 'https://userapi-compute-sepolia-dev.eigencloud.xyz',
  sepolia: 'https://userapi-compute-sepolia-prod.eigencloud.xyz',
  'mainnet-alpha': 'https://userapi-compute.eigencloud.xyz',
};

export async function getQuote(body) {
  const nonce = String(body.nonce ?? '');
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    return { status: 400, json: { error: 'nonce must be 32 bytes hex' } };
  }

  // The teeserver hashes nothing for us — bind the caller nonce into the
  // challenge so the returned quote is fresh for THIS request.
  const challenge = crypto
    .createHash('sha256')
    .update('ATTESTATION_BADGE_QUOTE_V1')
    .update(Buffer.from([0]))
    .update(Buffer.from(nonce, 'hex'))
    .digest();

  try {
    const attestation = await teeRequest('/v1/bound_evidence', {
      challenge: challenge.toString('base64'),
    });
    return {
      status: 200,
      json: {
        inTee: true,
        nonce,
        challengePrefix: 'ATTESTATION_BADGE_QUOTE_V1',
        quote: attestation.toString('base64'),
        fetchedAt: new Date().toISOString(),
        verifyHint:
          'challenge = SHA256(prefix || 0x00 || nonce_bytes); verify the quote against GCP Confidential Space roots with go-tpm-tools',
      },
    };
  } catch (err) {
    // Not in a TEE (local dev) — say so honestly instead of failing.
    return {
      status: 200,
      json: { inTee: false, nonce, error: err.message, fetchedAt: new Date().toISOString() },
    };
  }
}

export async function getProvenance(digest, envName) {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return { status: 400, json: { error: 'digest must be sha256:<64 hex>' } };
  }
  const userApi =
    USER_APIS[
      envName ?? process.env.APP_ENVIRONMENT_PUBLIC ?? process.env.APP_ENVIRONMENT ?? 'mainnet-alpha'
    ];
  if (!userApi) {
    return { status: 400, json: { error: `unknown environment; one of: ${Object.keys(USER_APIS)}` } };
  }
  const res = await fetch(`${userApi}/builds/verify/${digest}`);
  const json = await res.json().catch(() => ({ error: 'invalid upstream response' }));
  return { status: res.status, json };
}

function teeRequest(path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        socketPath: TEE_SOCKET,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`teeserver ${res.statusCode}: ${Buffer.concat(chunks)}`));
          } else {
            resolve(Buffer.concat(chunks));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`no teeserver socket (${e.code ?? e.message})`)));
    req.setTimeout(5000, () => req.destroy(new Error('teeserver timeout')));
    req.write(body);
    req.end();
  });
}
