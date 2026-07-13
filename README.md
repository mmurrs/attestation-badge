# attestation-badge

**A README badge tells you the build passed. This one proves the code answering you right now is that commit.**

This repo is a working demo of making EigenCompute's verifiability *legible* — a React
badge any app can embed that walks a user, in their own browser, from a line of source
code on GitHub to the container serving their requests.

```
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│   SOURCE    │───▶│   BUILD    │───▶│  RELEASE   │───▶│  RUNTIME   │
│ GitHub blob │    │    SLSA    │    │  on-chain  │    │ TEE quote  │
│ @ commit    │    │ provenance │    │ AppUpgraded│    │ w/ nonce   │
└────────────┘    └────────────┘    └────────────┘    └────────────┘
 raw.github…       build API          public RPC        the app itself
 (not the app)     (Cloud Build)      (not the app)     (opt-in routes)
```

Every arrow is checked in the browser, and every fact comes from a surface the app
does **not** control — except the last one, which is the enclave answering a fresh
challenge only real attested hardware can answer.

## The demo: anonbox

`app/` is a deliberately tiny anonymous suggestion box. Its claim: **"we can't know
it was you."** Its entire write path is
[`app/api/inbox.js`](app/api/inbox.js) — the handler has your IP and user-agent in
scope and stores `{ id, text, day }`. No IP, no session, no timestamp sharper than a
day.

Any app can *say* that. The badge on the page proves the deployed build is exactly
this source, so "read the code yourself" becomes a real audit invitation:

```jsx
import { AttestationBadge } from './badge/AttestationBadge.jsx';

<AttestationBadge
  source={{ file: 'app/api/inbox.js', lines: [12, 37] }}  // auto: commit from the running build
  appAddress="0xYourAppAddress"
  environment="sepolia"
/>
```

You can also pin an exact permalink (strict mode — fails loudly if the running build
drifts from it):

```jsx
<AttestationBadge
  permalink="https://github.com/you/app/blob/<40-char-sha>/api/handler.js#L10-L30"
  appAddress="0xYourAppAddress"
  environment="sepolia"
/>
```

## What each step really proves

1. **On-chain release** — your browser asks a public Ethereum RPC (not this app)
   which image digest the `AppController` contract has recorded for this app. Read
   from the `AppUpgraded` event; the EigenCloud operator can't serve a different
   image without that fact being publicly visible on-chain first.
2. **Verifiable build** — EigenCompute's build service (Google Cloud Build) built
   that digest from a public git commit and signed the link as SLSA provenance in a
   DSSE envelope (`GET /builds/verify/<digest>`, public). No developer laptop in the
   loop — the binary provably came from the repo.
3. **Running source** — the highlighted lines are fetched from
   `raw.githubusercontent.com` at that commit. What you read is what was built.
4. **Runtime attestation** — the page generates a 32-byte nonce; the app's
   `/attest/token` route (see [`app/api/attest.js`](app/api/attest.js)) has Google's
   attestation service check this VM's TPM quote and mint an OIDC JWT with that
   nonce embedded. The browser then verifies the JWT itself — RS256 via WebCrypto
   against Google's JWKS, nonce freshness, and `image_digest` == the on-chain
   digest from step 1. Only code inside the attested VM can reach the socket that
   mints these.

Every step is also reproducible from your own terminal with zero trust in the app
or the badge — the full recipe is in **[VERIFY.md](VERIFY.md)**.

## What it deliberately does NOT claim

Honesty is the product. The badge never claims:

- **"This line is the whole story."** Attestation proves the *build*, not that the
  highlighted line is load-bearing. A different code path could still betray you —
  which is why anonbox keeps its attested surface in ~350 lines. The badge is an
  *audit entry point*; smallness is what makes the audit real.
- **"The badge itself is the root of trust."** This panel is served by the app it
  verifies; a malicious operator could serve a lying badge. That's why every step
  links to evidence on an independent surface (GitHub, Etherscan, the
  [EigenCloud dashboard](https://verify.eigencloud.xyz)) — and why the panel's
  footer says exactly this. Cross-check there; the badge is the convenience, the
  chain + dashboard are the authority.
- **"Your browser checked the hardware roots."** The browser *does* real crypto on
  the runtime leg — it verifies a Google-signed attestation token (RS256 via
  WebCrypto against Google's CORS-open JWKS), checks its own fresh nonce inside
  `eat_nonce`, and requires the token's `image_digest` to equal the on-chain
  release digest. But that roots in Google's attestation service vouching for the
  TPM quote, not in AMD silicon directly. For a check that removes Google from the
  trust base, the raw quote stays downloadable for offline `go-tpm-tools`
  verification. The badge states this trust base instead of pretending.

Real-world caveats a deploying app must own (learned studying a production app with
the same anonymity claim): access logs can deanonymize even when the database
doesn't (this repo's Caddyfile discards them — and being in the attested image, that
*choice* is itself verifiable); auth-provider callbacks leak activity timing; and
free-text fields let users identify themselves.

## Live reference deploy

anonbox runs on EigenCompute mainnet with all four legs green (`verified-live`):

- **App:** http://34.91.160.140:8080 — click the badge (or append `?open`)
- **App ID:** `0x9633512c5AB3EF257e3a1C0F7694eB88a72DCc06`
  ([EigenCloud dashboard](https://verify.eigencloud.xyz/app/0x9633512c5AB3EF257e3a1C0F7694eB88a72DCc06))
- Built verifiably from commit
  [`a07781d`](https://github.com/mmurrs/attestation-badge/tree/a07781da993bd46870bbc12d9b8c37fec68ff9b7);
  the on-chain release digest, the SLSA provenance, and the source the badge shows
  all resolve to that commit — and the enclave answers fresh nonce-bound quotes at
  `POST /attest/quote`.

## Run it

```bash
npm install
npm run dev          # builds the bundle, serves http://localhost:8080
npm test             # verification core against real captured fixtures
```

Locally the badge shows: release ✕ (zero address), build –, runtime "not in a TEE" —
failure states are part of the demo. Point it at any EigenCompute app with a
verifiable build via URL params to see the first three legs go green, e.g.
`/?app=0xF174BC083D3FDE2a9bEae3f34FC31791fb2ca5aE&env=mainnet-alpha&open`.

## Deploy verifiably (the one command that matters)

```bash
ecloud compute app deploy \
  --verifiable \
  --repo https://github.com/mmurrs/attestation-badge \
  --commit <40-char-sha> \
  --build-caddyfile Caddyfile \
  --env-file .env \
  --environment sepolia
```

Then upgrade once with the app's own address in public env —
`APP_ADDRESS=0x… APP_ENVIRONMENT=sepolia` in the env file's public section — so the
badge's configuration is itself part of the on-chain release. The repo **must be
public** — that's not a limitation, it's the point.

## Repo layout

```
badge/                     the embeddable part (lift this directory)
  AttestationBadge.jsx     pill + Verification Center (React)
  verify.js                framework-free chain walker — usable without React
  abi.js                   AppController addresses + AppUpgraded ABI (v1.4/v1.5)
  badge.css                self-contained styles
app/                       anonbox — the attested surface (~350 LOC, stdlib only)
  api/inbox.js             THE money shot: identity in scope, never stored
  api/attest.js            opt-in: nonce'd TEE quote + provenance proxy
  server.js                every route visible in one switch; no request logging
test/                      core tests against real captured fixtures
  fixtures/                a real on-chain AppUpgraded log + a real DSSE envelope
```

## Status / known gaps

- The userapi provenance endpoint is public but CORS-allowlisted to official
  dashboards, so the badge reads it through the app's same-origin proxy
  (`/attest/provenance/...`). The response is a signed DSSE envelope, so proxying
  doesn't add trust in the app — but a CORS-open provenance endpoint (or an
  allowlisted badge origin) would remove the app from that path entirely. Platform ask.
- The DSSE signer's public key isn't served with the envelope, so client-side
  signature verification needs an out-of-band key pin. Second platform ask.
- Runtime: the badge's preferred path verifies a Confidential Space *token*
  (Google-signed OIDC JWT) fully in-browser. **EigenCompute's launcher currently
  runs in self-verification mode, which disables the `/v1/token` endpoint**
  (`no GCA verifier client present`) — so on EigenCompute today the badge falls
  back to the nonce-bound raw quote and says so honestly. Platform ask: re-enable
  GCA tokens or ship an equivalent platform-signed, CORS-open attestation token.
- Browser verification of the raw vTPM/SNP quote against hardware roots would need
  a JS/WASM port of go-tpm-tools/go-sev-guest — until then that check is offline-only.

MIT
