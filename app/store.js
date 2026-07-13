// Append-only JSONL store. A file, not a database, so an auditor can see
// the full shape of what persistence CAN hold by reading one function.

import fs from 'node:fs';
import path from 'node:path';

export function createStore(file = process.env.DATA_FILE ?? '/data/suggestions.jsonl') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

  return {
    append(entry) {
      entries.push(entry);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    },
    list() {
      return entries;
    },
  };
}
