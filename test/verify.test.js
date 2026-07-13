// Tests for the verification core against REAL captured fixtures:
//  - the AppUpgraded log EigenFloor emitted on sepolia (block 11173502)
//  - the DSSE provenance envelope for a real verifiable build (proxy-arena)
// Run: npm test

import assert from 'node:assert';
import { test } from 'node:test';
import { decodeEventLog } from 'viem';
import { parsePermalink, resolveSource } from '../badge/verify.js';
import { APP_UPGRADED_V14, APP_UPGRADED_V15 } from '../badge/abi.js';
import appUpgradedFixture from './fixtures/appupgraded-proxywar.json' with { type: 'json' };
import provenanceFixture from './fixtures/provenance-proxy-arena.json' with { type: 'json' };

test('parsePermalink extracts owner/repo/commit/path/lines', () => {
  const p = parsePermalink(
    'https://github.com/mmurrs/attestation-badge/blob/87affa07ad61f8cce1b7117dffa6868035ac6952/app/api/inbox.js#L12-L37'
  );
  assert.equal(p.owner, 'mmurrs');
  assert.equal(p.repo, 'attestation-badge');
  assert.equal(p.commit, '87affa07ad61f8cce1b7117dffa6868035ac6952');
  assert.equal(p.path, 'app/api/inbox.js');
  assert.equal(p.lineStart, 12);
  assert.equal(p.lineEnd, 37);
});

test('parsePermalink rejects branch links (must pin a sha)', () => {
  assert.throws(() =>
    parsePermalink('https://github.com/mmurrs/attestation-badge/blob/main/app/api/inbox.js')
  );
});

test('decodes a real mainnet AppUpgraded log with the v1.4 ABI', () => {
  const { args } = decodeEventLog({
    abi: [APP_UPGRADED_V14],
    data: appUpgradedFixture.data,
    topics: appUpgradedFixture.topics,
  });
  assert.equal(args.app.toLowerCase(), '0xf174bc083d3fde2a9beae3f34fc31791fb2ca5ae');
  assert.equal(args.rmsReleaseId, 2n);
  const artifact = args.release.rmsRelease.artifacts[0];
  assert.equal(
    artifact.digest,
    '0x75817aca3dc602fb83e776ea9d25c61e582277c840587455a16eb5d8b84c6272'
  );
  assert.equal(artifact.registry, 'docker.io/eigenlayer/eigencloud-containers');
});

test('v1.5 ABI does NOT decode the v1.4 log (version fallback is real)', () => {
  assert.throws(() =>
    decodeEventLog({
      abi: [APP_UPGRADED_V15],
      data: appUpgradedFixture.data,
      topics: appUpgradedFixture.topics,
    })
  );
});

test('provenance fixture: DSSE payload matches the JSON view (commit ↔ digest)', () => {
  const p = provenanceFixture;
  assert.equal(p.status, 'verified');
  assert.equal(p.payload_type, 'application/vnd.in-toto+json');
  const payload = JSON.parse(Buffer.from(p.payload, 'base64').toString());
  assert.equal(payload._type, 'https://in-toto.io/Statement/v0.1');
  // The signed payload and the convenience JSON must agree — if they ever
  // diverge, trust the signed payload.
  assert.deepEqual(payload.subject, p.provenance_json.subject);
  assert.equal(
    payload.predicate.materials[0].digest.sha1,
    p.git_ref
  );
  assert.equal(payload.subject[0].digest.sha256, p.image_digest.replace('sha256:', ''));
});

test('resolveSource auto mode builds the permalink from provenance', () => {
  const { link, mode } = resolveSource(
    { source: { file: 'app/api/inbox.js', lines: [12, 37] } },
    { repoUrl: 'https://github.com/mmurrs/attestation-badge', commit: 'a'.repeat(40) }
  );
  assert.equal(mode, 'auto');
  assert.equal(link.owner, 'mmurrs');
  assert.equal(link.path, 'app/api/inbox.js');
  assert.equal(link.lineStart, 12);
  assert.ok(link.url.endsWith(`blob/${'a'.repeat(40)}/app/api/inbox.js#L12-L37`));
});
