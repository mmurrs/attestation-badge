# Verify the whole thing yourself

The badge is a convenience. Everything it shows can be reproduced from your own
terminal, trusting only: Ethereum, GitHub, Google's attestation service, and (for
the deepest check) AMD/GCP hardware roots. The app is not in this loop — every
command below hits an independent surface, except the ones where the *point* is
to challenge the enclave.

Values below are for the reference deploy; substitute your own.

```bash
APP=0x9633512c5AB3EF257e3a1C0F7694eB88a72DCc06   # anonbox app id
APP_URL=http://34.91.160.140:8080                 # the running instance
CONTROLLER=0xc38d35Fc995e75342A21CBd6D770305b142Fbe67  # AppController (mainnet-alpha)
RPC=https://eth.drpc.org                          # any archive-capable RPC you trust
```

## 1. Chain — what is this app committed to running?

Ask the AppController which block confirmed the current release, then read the
`AppUpgraded` event from that block:

```bash
# getAppLatestReleaseBlockNumber(address) selector = 0x9ffbdce6
BLOCK_HEX=$(curl -s $RPC -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"eth_call",
  "params":[{"to":"'$CONTROLLER'","data":"0x9ffbdce6000000000000000000000000'${APP#0x}'"},"latest"]
}' | jq -r .result)
BLOCK=$(printf '%d' $BLOCK_HEX)

curl -s $RPC -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":2,"method":"eth_getLogs",
  "params":[{"address":"'$CONTROLLER'",
    "topics":[null,"0x000000000000000000000000'${APP#0x}'"],
    "fromBlock":"'$BLOCK_HEX'","toBlock":"'$BLOCK_HEX'"}]
}' | jq '.result[0].data' 
```

The event data ABI-decodes to a `Release` whose first artifact is
`(bytes32 digest, string registry)` — that bytes32 is the **image digest** this
app must run. (Any ABI decoder works; `cast` one-liner:
`cast decode-event --sig "AppUpgraded(address,uint256,(((bytes32,string)[],uint32),bytes,bytes))" <data>`.)

Expected for the reference deploy: `sha256:177255d0c8d3…` — also visible on the
[EigenCloud dashboard](https://verify.eigencloud.xyz/app/0x9633512c5AB3EF257e3a1C0F7694eB88a72DCc06)
and [Etherscan](https://etherscan.io/address/0xc38d35Fc995e75342A21CBd6D770305b142Fbe67).

## 2. Build — where did that digest come from?

The provenance API is public (no auth):

```bash
DIGEST=sha256:<from step 1>
curl -s https://userapi-compute.eigencloud.xyz/builds/verify/$DIGEST > prov.json
jq '{status, repo_url, git_ref, image_digest}' prov.json
```

Don't take `status: verified` on faith — the response carries the signed DSSE
payload. Decode it and check it agrees:

```bash
jq -r .payload prov.json | base64 -d | jq '{
  subject_digest: .subject[0].digest.sha256,
  commit: .predicate.materials[0].digest.sha1,
  repo: .predicate.materials[0].uri,
  builder: .predicate.builder.id
}'
```

The `subject_digest` must equal the on-chain digest from step 1, and `commit` is
the git SHA everything else hangs on. (The DSSE ECDSA signature itself is
platform-verified at ingest; the signer public key isn't published yet — flagged
in README "Status / known gaps".)

Or with the CLI: `ecloud compute build verify $DIGEST --environment mainnet-alpha`.

## 3. Source — read the code that digest was built from

```bash
COMMIT=<from step 2>
git clone https://github.com/mmurrs/attestation-badge && cd attestation-badge
git checkout $COMMIT
wc -l app/server.js app/store.js app/api/*.js Dockerfile Caddyfile
```

~300 lines. Read `app/api/inbox.js` first — the anonymity claim is L12–L37.
This is the audit the whole chain exists to make meaningful. Optionally rebuild
the image from the same Dockerfile and compare layers.

## 4. Runtime — is that code what's answering, right now?

Two paths. **4a is fully verifiable with standard JWT tooling but requires the
platform's Google-token endpoint, which EigenCompute's launcher currently
disables** (self-verification mode → `no GCA verifier client present`). 4b works
today.

### 4a. Attestation token (when the platform enables it)

Challenge the enclave with **your own** nonce (32 bytes hex, yours, fresh):

```bash
NONCE=$(openssl rand -hex 32)
curl -s $APP_URL/attest/token -H 'Content-Type: application/json' \
  -d '{"nonce":"'$NONCE'","audience":"https://attestation-badge"}' | jq -r .token > token.jwt
```

The response is an OIDC JWT minted by **Google's Confidential Space attestation
service** after it checked the vTPM quote of this exact VM. Verify it with any
JWT tooling — nothing EigenCloud-specific:

```bash
# claims
cut -d. -f2 token.jwt | base64 -d 2>/dev/null | jq '{
  iss, aud, exp, hwmodel, swname, secboot,
  eat_nonce, image_digest: .submods.container.image_digest
}'
```

Check, in order:
- `iss` = `https://confidentialcomputing.googleapis.com`, `exp` in the future
- signature verifies against Google's JWKS
  (`https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com`) —
  e.g. `jwt verify` / jose / step CLI, or paste into any JWT debugger
- `eat_nonce` contains **your** nonce → this attestation was produced after your
  challenge; it cannot be a replay
- `submods.container.image_digest` equals the **on-chain digest from step 1** →
  the attested container is the one the chain committed to
- `hwmodel` `GCP_AMD_SEV_SNP`, `secboot` true

That closes the loop: *chain digest = built-from-commit digest = attested
running digest*, and the code at that commit is ~350 lines you just read.

### 4b. Raw quote with your nonce (works today)

See step 5 — same challenge flow; the quote is bound to your nonce, so a
successful response already proves a live enclave answered *your* challenge
(only in-VM code reaches the teeserver socket). Full signature verification of
that quote is the offline check below.

## 5. Deeper: hardware-root check (no Google in the trust base)

The token trusts Google's attestation service to have checked the TPM quote.
To verify against hardware roots yourself, fetch the raw quote with a fresh
nonce and use go-tpm-tools offline:

```bash
NONCE=$(openssl rand -hex 32)
curl -s $APP_URL/attest/quote -H 'Content-Type: application/json' \
  -d '{"nonce":"'$NONCE'"}' | jq -r .quote | base64 -d > quote.bin
# challenge = SHA256("ATTESTATION_BADGE_QUOTE_V1" || 0x00 || nonce_bytes)
# then: github.com/google/go-tpm-tools verify debug --nonce <challenge> quote.bin
```

## What you had to trust, per step

| Step | Trust base |
| --- | --- |
| 1 Chain | your RPC (use several / your own node) |
| 2 Build | Cloud Build provenance + platform DSSE check (signer key unpublished) |
| 3 Source | GitHub serving the commit content-addressed by SHA |
| 4 Runtime | Google's attestation service + AMD SEV-SNP |
| 5 Raw quote | AMD/GCP hardware roots only |

No step trusts the app, and no step trusts the badge.
