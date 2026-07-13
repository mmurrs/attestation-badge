import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttestationBadge } from '../../badge/AttestationBadge.jsx';

// Deploy config comes from the server (/attest/config, fed by on-chain publicEnv),
// overridable by URL params so the badge can be pointed at any app:
// /?app=0x…&env=sepolia-dev&open
const params = new URLSearchParams(location.search);
const OPEN = params.has('open');

function useDeployConfig() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    fetch('/attest/config')
      .then((r) => r.json())
      .then((c) =>
        setCfg({
          appAddress:
            params.get('app') ?? c.appAddress ?? '0x0000000000000000000000000000000000000000',
          environment: params.get('env') ?? c.environment ?? 'mainnet-alpha',
        })
      )
      .catch(() =>
        setCfg({
          appAddress: params.get('app') ?? '0x0000000000000000000000000000000000000000',
          environment: params.get('env') ?? 'mainnet-alpha',
        })
      );
  }, []);
  return cfg;
}

function App() {
  const cfg = useDeployConfig();
  const [text, setText] = useState('');
  const [items, setItems] = useState([]);
  const [sent, setSent] = useState(false);

  const load = () =>
    fetch('/api/suggestions')
      .then((r) => r.json())
      .then(setItems)
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    await fetch('/api/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    setText('');
    setSent(true);
    setTimeout(() => setSent(false), 2500);
    load();
  };

  return (
    <main className="page">
      <header className="mast">
        <span className="mast-name">anonbox</span>
        <span className="mast-tag">an anonymous suggestion box that can prove it</span>
      </header>

      <section className="claim">
        <h1>
          Say anything.
          <br />
          We can't know it was you.
        </h1>
        <p className="claim-sub">
          Most apps ask you to trust that sentence. This one lets you check it — the badge
          below verifies, in your browser, that the code handling your submission is exactly
          the code published on GitHub. The store-what-you-said function is{' '}
          <a
            href="https://github.com/mmurrs/attestation-badge/blob/main/app/api/inbox.js"
            target="_blank"
            rel="noreferrer"
          >
            30 lines
          </a>
          . Read it, then make the badge prove it's what's running.
        </p>
        <div className="claim-badge">
          {cfg && (
            <AttestationBadge
              source={{ file: 'app/api/inbox.js', lines: [12, 37] }}
              appAddress={cfg.appAddress}
              environment={cfg.environment}
              appOrigin=""
              defaultOpen={OPEN}
            />
          )}
          <span className="claim-badge-note">← click it</span>
        </div>
      </section>

      <section className="box">
        <form onSubmit={submit}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            rows={3}
            placeholder="What should we hear that you wouldn't put your name on?"
            aria-label="Anonymous suggestion"
          />
          <div className="box-row">
            <span className="box-kept">
              kept: <code>{'{ id, text, day }'}</code> — not your IP, not a session, not a
              timestamp sharper than a day
            </span>
            <button type="submit">{sent ? 'Sent — nothing to trace' : 'Send anonymously'}</button>
          </div>
        </form>

        <ul className="feed">
          {items.map((it) => (
            <li key={it.id}>
              <span className="feed-day">{it.day}</span>
              <span>{it.text}</span>
            </li>
          ))}
          {items.length === 0 && <li className="feed-empty">No suggestions yet. Be first.</li>}
        </ul>
      </section>

      <section className="how">
        <h2>What the badge actually checks</h2>
        <ol>
          <li>
            <strong>On-chain release.</strong> Your browser asks a public Ethereum RPC which
            container image this app is committed to running. The app can't answer this for
            itself.
          </li>
          <li>
            <strong>Verifiable build.</strong> EigenCompute's build service compiled that exact
            image from a public GitHub commit and signed the link between them (SLSA
            provenance). No laptop in the loop.
          </li>
          <li>
            <strong>Running source.</strong> The lines in the badge come from GitHub at that
            commit — not from this server.
          </li>
          <li>
            <strong>Runtime attestation.</strong> The enclave answers a fresh challenge from
            your browser, proving the attested machine is the one serving you — not a
            look-alike.
          </li>
        </ol>
        <p className="how-honest">
          What it can't do: make one highlighted line mean the whole app is safe. That's why
          this app keeps its attested surface under 300 lines — small enough that "read the
          code yourself" is a real invitation, not a shrug.
        </p>
      </section>

      <footer className="foot">
        <a href="https://github.com/mmurrs/attestation-badge" target="_blank" rel="noreferrer">
          source
        </a>
        <span>·</span>
        <span>runs on EigenCompute</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
