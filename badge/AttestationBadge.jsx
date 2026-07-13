// <AttestationBadge> — a shields-style pill that expands into a Verification Center.
//
// The pill is the resting state. Clicking it walks the chain of custody live
// (source → build → on-chain release → runtime quote) and renders each step
// with its independent evidence link. Plain-English claims lead; hashes and
// raw payloads sit behind "Show evidence".
//
// Honesty rules baked in:
//   - This component is served by the app it verifies, so it links every step
//     to a surface the app does NOT control (GitHub, Etherscan, the EigenCloud
//     dashboard) and says so in the footer.
//   - Verdict wording distinguishes "verified build + on-chain release" from
//     "live TEE quote", and never claims a single line is load-bearing.

import React, { useEffect, useRef, useState } from 'react';
import { verifyChain } from './verify.js';

const STATE_ICON = { verified: '✓', failed: '✕', unavailable: '–' };

export function AttestationBadge(props) {
  const [open, setOpen] = useState(!!props.defaultOpen);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);
  const running = useRef(false);

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      setResult(await verifyChain(props));
      setCheckedAt(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      running.current = false;
    }
  };

  useEffect(() => {
    if (open && !result && !error) run();
  }, [open]);

  const verdict = result?.verdict;
  const pillClass =
    verdict === 'verified-live' || verdict === 'verified-build'
      ? 'ab-ok'
      : verdict === 'failed'
        ? 'ab-bad'
        : '';

  return (
    <div className="ab-root">
      <button
        className={`ab-pill ${pillClass}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="ab-pill-key">code</span>
        <span className="ab-pill-val">
          {!result && !error && 'prove it'}
          {error && 'check failed'}
          {verdict === 'verified-live' && `live @ ${result.link?.commit.slice(0, 7) ?? 'commit'}`}
          {verdict === 'verified-build' && `verified @ ${result.link?.commit.slice(0, 7) ?? 'commit'}`}
          {verdict === 'failed' && 'unverified'}
        </span>
      </button>

      {open && (
        <div className="ab-panel" role="dialog" aria-label="Verification Center">
          <div className="ab-panel-head">
            <strong>Verification Center</strong>
            <span className="ab-head-note">
              {result
                ? verdict === 'verified-live'
                  ? 'This response was served by the code below.'
                  : verdict === 'verified-build'
                    ? 'The deployed build is exactly the code below.'
                    : 'Verification did not complete.'
                : 'Checking…'}
            </span>
            <button className="ab-refresh" onClick={() => { setResult(null); run(); }}>
              re-check
            </button>
          </div>

          {error && <div className="ab-error">{error}</div>}
          {!result && !error && <div className="ab-loading">Walking the chain of custody…</div>}

          {result && (
            <ol className="ab-chain">
              {result.steps.map((s) => (
                <Step key={s.id} step={s} />
              ))}
            </ol>
          )}

          {result?.steps[0]?.evidence?.source?.lines && (
            <SourceExcerpt link={result.link} source={result.steps[0].evidence.source} />
          )}

          <div className="ab-foot">
            {checkedAt && <span>checked {checkedAt.toLocaleTimeString()} · </span>}
            This panel is served by the app it verifies — treat it as a convenience, not the
            root of trust. Every step links to evidence on a site this app doesn't control.
          </div>
        </div>
      )}
    </div>
  );
}

function Step({ step }) {
  return (
    <li className={`ab-step ab-${step.state}`}>
      <span className="ab-step-icon" aria-hidden>
        {STATE_ICON[step.state]}
      </span>
      <div className="ab-step-body">
        <span className="ab-step-title">{step.title}</span>
        <span className="ab-step-detail">{step.detail}</span>
        {step.evidence?.checks && (
          <ul className="ab-checks">
            {step.evidence.checks.map((c) => (
              <li key={c.name} className={c.ok ? '' : 'ab-check-bad'}>
                {c.name}: {c.detail}
              </li>
            ))}
          </ul>
        )}
        {step.caveat && step.state === 'verified' && (
          <span className="ab-step-caveat">{step.caveat}</span>
        )}
        <span className="ab-step-links">
          {step.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
              {l.label} ↗
            </a>
          ))}
          {Object.keys(step.evidence ?? {}).length > 0 && (
            <details className="ab-evidence">
              <summary>Show evidence</summary>
              <pre>{safeStringify(step.evidence)}</pre>
            </details>
          )}
        </span>
      </div>
    </li>
  );
}

// Minimal JS tokenizer for the excerpt — GitHub light-theme classes, no deps.
const TOKEN_RE =
  /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|of|in|new|import|export|from|async|await|throw|try|catch|class|extends|null|undefined|true|false)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\()/gm;

function highlight(line) {
  const out = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const cls = m[1] ? 'ab-tok-c' : m[2] ? 'ab-tok-s' : m[3] ? 'ab-tok-k' : m[4] ? 'ab-tok-n' : 'ab-tok-f';
    out.push(
      <span key={m.index} className={cls}>
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function formatBytes(n) {
  return n < 1024 ? `${n} Bytes` : `${(n / 1024).toFixed(1)} KB`;
}

// Rendered to read as GitHub's blob view: commit chip + path breadcrumb,
// Code|Blame control, "N lines (N loc) · size" metadata, Raw/Copy, and the
// selected range in GitHub's yellow with white context lines around it.
function SourceExcerpt({ link, source }) {
  const [copied, setCopied] = useState(false);
  if (!link || source.error) return null;
  const rawUrl = `https://raw.githubusercontent.com/${link.owner}/${link.repo}/${link.commit}/${link.path}`;
  const crumbs = link.path.split('/');
  const copy = () => {
    navigator.clipboard?.writeText(source.lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="ab-src">
      <div className="ab-src-top">
        <a className="ab-src-ref" href={link.url} target="_blank" rel="noreferrer" title="Pinned commit">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor">
            <path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" />
          </svg>
          {link.commit.slice(0, 7)}
        </a>
        <span className="ab-src-crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="ab-src-sep">/</span>}
              <span className={i === crumbs.length - 1 ? 'ab-src-crumb-file' : ''}>{c}</span>
            </span>
          ))}
        </span>
      </div>
      <div className="ab-src-bar">
        <span className="ab-src-tabs" role="tablist">
          <span className="ab-src-tab ab-src-tab-on">Code</span>
          <span className="ab-src-tab">Blame</span>
        </span>
        <span className="ab-src-meta">
          {source.totalLines} lines ({source.loc} loc) · {formatBytes(source.bytes)}
        </span>
        <span className="ab-src-actions">
          <a href={rawUrl} target="_blank" rel="noreferrer">
            Raw
          </a>
          <button type="button" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
        </span>
      </div>
      <pre className="ab-src-code">
        {source.lines.map((line, i) => {
          const n = source.start + i;
          const hl = n >= source.hlStart && n <= source.hlEnd;
          return (
            <div key={n} className={`ab-src-line${hl ? ' ab-src-hl' : ''}`}>
              <span className="ab-src-no">{n}</span>
              <span className="ab-src-text">{highlight(line)}</span>
            </div>
          );
        })}
        {source.end < source.totalLines && (
          <div className="ab-src-line ab-src-more">
            <span className="ab-src-no">…</span>
            <a href={link.url} target="_blank" rel="noreferrer">
              view all {source.totalLines} lines on GitHub
            </a>
          </div>
        )}
      </pre>
    </div>
  );
}

function safeStringify(o) {
  return JSON.stringify(
    o,
    (k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'string' && v.length > 400) return v.slice(0, 400) + `… (${v.length} chars)`;
      return v;
    },
    2
  );
}
