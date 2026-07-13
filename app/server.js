// anonbox server. No framework — every route the attested image serves is
// visible in this one switch. This file, api/, and store.js are the entire
// attested surface; read them and you have read the app.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitSuggestion, listSuggestions } from './api/inbox.js';
import { getQuote, getProvenance } from './api/attest.js';
import { createStore } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 8080;
const store = createStore();

// Deliberately absent: request logging. Access logs are how "anonymous"
// apps deanonymize people (see README: EigenFloor's PII-logging fix).

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'POST /api/suggestions') {
      return send(res, submitSuggestion(req, await readJson(req), store));
    }
    if (route === 'GET /api/suggestions') {
      return send(res, listSuggestions(store));
    }
    if (route === 'POST /attest/quote') {
      return send(res, await getQuote(await readJson(req)));
    }
    if (route === 'GET /attest/config') {
      // The *_PUBLIC suffix routes these into the release's publicEnv, so the
      // values the badge configures itself with are recorded on-chain.
      return send(res, {
        status: 200,
        json: {
          appAddress: process.env.APP_ADDRESS_PUBLIC ?? process.env.APP_ADDRESS ?? null,
          environment:
            process.env.APP_ENVIRONMENT_PUBLIC ?? process.env.APP_ENVIRONMENT ?? 'mainnet-alpha',
        },
      });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/attest/provenance/')) {
      return send(
        res,
        await getProvenance(url.pathname.split('/').pop(), url.searchParams.get('env'))
      );
    }
    return serveStatic(url.pathname, res);
  } catch (err) {
    // Error text only — no request details, same no-logging rule as above.
    send(res, { status: 500, json: { error: err.message } });
  }
});

function send(res, { status, json }) {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(__dirname, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

server.listen(PORT, () => console.log(`anonbox listening on :${PORT}`));
