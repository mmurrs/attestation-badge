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
   `/attest/quote` route (see [`app/api/attest.js`](app/api/attest.js)) binds it into
   a challenge on the in-enclave attestation socket and returns the hardware quote.
   Only code running inside the attested VM can reach that socket, and the nonce
   rules out replay.

## What it deliberately does NOT claim

Honesty is the product. The badge never claims:

- **"This line is the whole story."** Attestation proves the *build*, not that the
  highlighted line is load-bearing. A different code path could still betray you —
  which is why anonbox keeps its attested surface under ~300 lines. The badge is an
  *audit entry point*; smallness is what makes the audit real.
- **"The badge itself is the root of trust."** This panel is served by the app it
  verifies; a malicious operator could serve a lying badge. That's why every step
  links to evidence on an independent surface (GitHub, Etherscan, the
  [EigenCloud dashboard](https://verify.eigencloud.xyz)) — and why the panel's
  footer says exactly this. Cross-check there; the badge is the convenience, the
  chain + dashboard are the authority.
- **"Your browser checked the hardware signature."** Quote signature verification
  (against the confidential-computing roots) isn't browser-feasible today; the raw
  quote is downloadable for offline verification with `go-tpm-tools`, and the
  platform verifies it at ingest. The badge says so instead of pretending.

Real-world caveats a deploying app must own (learned studying a production app with
the same anonymity claim): access logs can deanonymize even when the database
doesn't (this repo's Caddyfile discards them — and being in the attested image, that
*choice* is itself verifiable); auth-provider callbacks leak activity timing; and
free-text fields let users identify themselves.

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
app/                       anonbox — the attested surface (~300 LOC, stdlib only)
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
- Runtime quotes: browser verification of vTPM/SNP signatures would need a JS/WASM
  port of the verifier stack. Until then: download + `go-tpm-tools`, or the dashboard.

MIT
