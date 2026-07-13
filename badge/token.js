// In-browser verification of a Confidential Space attestation token.
//
// The enclave's launcher exposes POST /v1/token on the in-VM socket: Google's
// attestation service checks the TPM quote and mints an OIDC JWT (RS256) over
// the same evidence, with caller nonces embedded as eat_nonce and the running
// container's image digest as a claim. The app proxies that route; this module
// then does what a browser CAN do natively:
//
//   1. verify the RS256 signature with WebCrypto against Google's JWKS
//      (www.googleapis.com — CORS-open, fetched by this page, not the app)
//   2. check iss / aud / exp / iat
//   3. check our freshly generated nonce is inside eat_nonce (no replay)
//   4. check the token's image_digest equals the ON-CHAIN release digest —
//      binding "what is running" to "what the chain says should run"
//
// Trust honesty: the signature roots in Google's attestation service (it
// vouches for the TPM quote), not directly in AMD silicon. Independent
// hardware-root verification of the raw quote still needs go-tpm-tools
// offline — the raw quote stays downloadable for exactly that.

const ISSUER = 'https://confidentialcomputing.googleapis.com';
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com';
export const TOKEN_AUDIENCE = 'https://attestation-badge';
const CLOCK_SKEW_S = 60;

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson(b64url) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url)));
}

export async function verifyAttestationToken(jwt, { nonce, expectedDigest }) {
  const checks = [];
  const fail = (name, detail) => {
    checks.push({ name, ok: false, detail });
    return { ok: false, checks, claims: null };
  };

  const parts = jwt.split('.');
  if (parts.length !== 3) return fail('format', 'not a JWT');
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]);

  if (header.alg !== 'RS256') return fail('algorithm', `unexpected alg ${header.alg}`);

  // 1. Signature — key comes from googleapis.com, fetched by this page.
  const jwks = await (await fetch(JWKS_URL)).json();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return fail('signature', `signing key ${header.kid} not in Google's JWKS`);
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return fail('signature', 'RS256 signature does not verify');
  checks.push({
    name: 'signature',
    ok: true,
    detail: `RS256 verified in this browser (WebCrypto) against Google key ${header.kid.slice(0, 8)}…`,
  });

  // 2. Standard claims.
  const now = Date.now() / 1000;
  if (claims.iss !== ISSUER) return fail('issuer', `iss is ${claims.iss}`);
  if (claims.aud !== TOKEN_AUDIENCE) return fail('audience', `aud is ${claims.aud}`);
  if (now > claims.exp + CLOCK_SKEW_S) return fail('expiry', 'token expired');
  if (now < (claims.nbf ?? claims.iat) - CLOCK_SKEW_S) return fail('expiry', 'token not yet valid');
  checks.push({ name: 'claims', ok: true, detail: `issuer ${ISSUER}, expires ${new Date(claims.exp * 1000).toLocaleTimeString()}` });

  // 3. Freshness — our nonce must be embedded.
  const nonces = [].concat(claims.eat_nonce ?? []);
  if (!nonces.includes(nonce)) return fail('nonce', 'token does not contain the nonce this page generated');
  checks.push({ name: 'nonce', ok: true, detail: 'contains the nonce this page just generated — replay ruled out' });

  // 4. The binding: running image == on-chain release.
  const digest = claims.submods?.container?.image_digest;
  if (expectedDigest) {
    if (digest !== expectedDigest) {
      return fail('image', `token says ${digest ?? 'none'}, on-chain release says ${expectedDigest}`);
    }
    checks.push({ name: 'image', ok: true, detail: `running image ${digest.slice(7, 19)} equals the on-chain release digest` });
  }

  // Environment facts worth surfacing (not pass/fail, but shown as evidence).
  checks.push({
    name: 'environment',
    ok: true,
    detail: `${claims.hwmodel ?? '?'} · ${claims.swname ?? '?'} · secboot ${claims.secboot} · debug ${claims.dbgstat ?? '?'}`,
  });

  return { ok: true, checks, claims };
}
