// Tests for in-browser token verification (badge/token.js) using a REAL
// RS256 signature: we mint a keypair, publish it via a mocked JWKS fetch,
// and sign JWTs locally. Everything WebCrypto-side runs exactly as it
// would in the browser (Node 22 exposes the same globals).

import assert from 'node:assert';
import { test, before, after } from 'node:test';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { verifyAttestationToken, TOKEN_AUDIENCE } from '../badge/token.js';

const KID = 'test-key-1';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function mintToken(claimOverrides = {}, headerOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...headerOverrides };
  const claims = {
    iss: 'https://confidentialcomputing.googleapis.com',
    aud: TOKEN_AUDIENCE,
    iat: now,
    nbf: now,
    exp: now + 3600,
    hwmodel: 'GCP_AMD_SEV_SNP',
    swname: 'CONFIDENTIAL_SPACE',
    secboot: true,
    eat_nonce: ['aa'.repeat(32)],
    submods: { container: { image_digest: 'sha256:' + 'ab'.repeat(32) } },
    ...claimOverrides,
  };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${sig.toString('base64url')}`;
}

const NONCE = 'aa'.repeat(32);
const DIGEST = 'sha256:' + 'ab'.repeat(32);
const realFetch = globalThis.fetch;

before(() => {
  // Serve our JWKS for the Google URL; anything else is a test bug.
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('googleapis.com/service_accounts')) {
      return new Response(JSON.stringify({ keys: [jwk] }));
    }
    return realFetch(url, opts);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

test('valid token passes all checks incl. image binding', async () => {
  const r = await verifyAttestationToken(mintToken(), { nonce: NONCE, expectedDigest: DIGEST });
  assert.equal(r.ok, true);
  assert.ok(r.checks.find((c) => c.name === 'signature')?.ok);
  assert.ok(r.checks.find((c) => c.name === 'image')?.ok);
});

test('tampered payload fails the signature check', async () => {
  const parts = mintToken().split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  claims.submods.container.image_digest = 'sha256:' + 'ee'.repeat(32);
  const forged = `${parts[0]}.${b64url(claims)}.${parts[2]}`;
  const r = await verifyAttestationToken(forged, { nonce: NONCE, expectedDigest: DIGEST });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => !c.ok).name, 'signature');
});

test('replayed token (wrong nonce) fails', async () => {
  const r = await verifyAttestationToken(mintToken(), { nonce: 'bb'.repeat(32), expectedDigest: DIGEST });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => !c.ok).name, 'nonce');
});

test('token attesting a different image than the on-chain release fails', async () => {
  const r = await verifyAttestationToken(mintToken(), {
    nonce: NONCE,
    expectedDigest: 'sha256:' + 'cd'.repeat(32),
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => !c.ok).name, 'image');
});

test('expired token fails', async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await verifyAttestationToken(mintToken({ exp: now - 600 }), {
    nonce: NONCE,
    expectedDigest: DIGEST,
  });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => !c.ok).name, 'expiry');
});

test('wrong issuer and alg=none are rejected', async () => {
  const wrongIss = await verifyAttestationToken(mintToken({ iss: 'https://evil.example' }), {
    nonce: NONCE,
    expectedDigest: DIGEST,
  });
  assert.equal(wrongIss.ok, false);

  const parts = mintToken().split('.');
  const noneToken = `${b64url({ alg: 'none', kid: KID })}.${parts[1]}.`;
  const noAlg = await verifyAttestationToken(noneToken, { nonce: NONCE, expectedDigest: DIGEST });
  assert.equal(noAlg.ok, false);
  assert.equal(noAlg.checks.find((c) => !c.ok).name, 'algorithm');
});
