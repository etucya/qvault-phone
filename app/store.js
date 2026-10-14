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
      // One key listing instead of a session read per bank.
      const [all, sessionKeys] = await Promise.all([adapter.getAll('banks'), adapter.keys('sessions')]);
      const withSession = new Set(sessionKeys);
      const summaries = all.map((bank) => {
        const hasSession = withSession.has(bank.path);
        try {
          const questions = withDates(bank.questions);
          const last = lastStudied(questions);
          return {
            path: bank.path,
            name: bank.name,
            md5: bank.md5,
            questionCount: questions.length,
            lastStudied: last === null ? null : iso(last),
            mastery: setSummary(questions).mastery,
            hasSession,
          };
        } catch {
          // One damaged bank must not take the whole library down.
          return {
            path: bank.path,
            name: bank.name,
            md5: bank.md5,
            questionCount: 0,
            lastStudied: null,
            mastery: 0,
            hasSession,
            corrupt: true,
          };
        }
      });
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
      return adapter.has('pictures', name);
    },
  };

  const meta = { ...keyed('meta'), delete: (key) => adapter.delete('meta', key) };

  return { banks, sessions, pictures, settings, meta };
}
