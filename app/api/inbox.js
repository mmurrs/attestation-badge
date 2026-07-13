// anonbox — the entire write path for suggestions.
//
// The claim this app makes: "we cannot know who said what."
// This file is the whole of that claim. There is no other code path
// that writes a suggestion.

import crypto from 'node:crypto';

const MAX_LENGTH = 500;

export function submitSuggestion(req, body, store) {
  // The server can see who you are at this moment. This is everything
  // it could choose to keep about you:
  const identity = {
    ip: req.socket.remoteAddress,
    userAgent: req.headers['user-agent'] ?? '',
    // (a real app would have a session/user id in scope here too)
  };

  const text = (body.text ?? '').trim().slice(0, MAX_LENGTH);
  if (!text) return { status: 400, json: { error: 'text is required' } };

  // What actually gets stored. Note what is absent: no ip, no user agent,
  // no session, no precise timestamp — `day` is date-granular on purpose,
  // so timing correlation against access logs is blunted.
  const entry = {
    id: crypto.randomUUID(),
    text,
    day: new Date().toISOString().slice(0, 10),
  };

  store.append(entry);

  // `identity` dies here, unused — and you can check that this is the
  // code that handled your request.
  return { status: 201, json: entry };
}

export function listSuggestions(store) {
  return { status: 200, json: store.list().slice(-50).reverse() };
}
