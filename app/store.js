// The phone's storage: banks, sessions, pictures, settings and meta, over an adapter
// (storeMemory.js for tests, storeIndexedDB.js in the browser).

import { setSummary, lastStudied } from './engine/stats.js';

// Attempt times are Dates in memory; tolerate ISO strings in case a record was stored raw.
function withDates(questions) {
  return questions.map((q) => {
    const attempts = q.stats?.attempts;
    if (!attempts || attempts.every((a) => a.at instanceof Date)) return q;
    return { ...q, stats: { ...q.stats, attempts: attempts.map((a) => ({ ...a, at: new Date(a.at) })) } };
  });
}

// ISO-8601 with whole seconds, no fractional part.
const iso = (date) => date.toISOString().replace(/\.\d+Z$/, 'Z');

export async function openStore(adapter) {
  const keyed = (name) => ({
    get: (key) => adapter.get(name, key),
    put: (key, value) => adapter.put(name, key, value),
  });

  const sessions = { ...keyed('sessions'), delete: (key) => adapter.delete('sessions', key) };
  const settings = keyed('settings');

  const banks = {
    async list() {
      const all = await adapter.getAll('banks');
      const summaries = [];
      for (const bank of all) {
        const questions = withDates(bank.questions);
        const last = lastStudied(questions);
        summaries.push({
          path: bank.path,
          name: bank.name,
          md5: bank.md5,
          questionCount: bank.questions.length,
          lastStudied: last === null ? null : iso(last),
          mastery: setSummary(questions).mastery,
          hasSession: (await sessions.get(bank.path)) !== null,
        });
      }
      return summaries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    },
    get: (path) => adapter.get('banks', path),
    put: (bank) => adapter.put('banks', bank.path, bank),
    async delete(path) {
      await adapter.delete('banks', path);
      await adapter.delete('sessions', path);
      await adapter.delete('settings', path);
    },
  };

  const pictures = {
    ...keyed('pictures'),
    async has(name) {
      return (await adapter.get('pictures', name)) !== null;
    },
  };

  return { banks, sessions, pictures, settings, meta: keyed('meta') };
}
