// IndexedDB storage adapter. Same interface as storeMemory.js: get / put / delete /
// getAll / keys / has per named store, plus clear. Database `qvault`, version 1.

const KEYED_STORES = ['sessions', 'pictures', 'settings', 'meta'];
const ALL_STORES = ['banks', ...KEYED_STORES];

const promisify = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function indexedDBAdapter(name = 'qvault') {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('banks', { keyPath: 'path' });
    for (const store of KEYED_STORES) db.createObjectStore(store);
  };
  const db = await promisify(opening);

  // Ask the browser not to evict our data. Fire and forget: opening never waits on it,
  // and failure or absence is fine.
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    // ignored
  }

  const run = (store, mode, fn) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    // A failed request also aborts the transaction, which rejects below; keep the
    // request's own rejection from surfacing a second time as an unhandled one.
    if (typeof result?.catch === 'function') result.catch(() => {});
    return finished(tx).then(() => result);
  };

  return {
    async get(store, key) {
      const value = await run(store, 'readonly', (s) => promisify(s.get(key)));
      return value === undefined ? null : value;
    },
    async put(store, key, value) {
      // `banks` has an in-line key (its `path`); the others take the key explicitly.
      await run(store, 'readwrite', (s) =>
        store === 'banks' ? s.put(value) : s.put(value, key),
      );
    },
    async delete(store, key) {
      await run(store, 'readwrite', (s) => s.delete(key));
    },
    async getAll(store) {
      return run(store, 'readonly', (s) => promisify(s.getAll()));
    },
    async keys(store) {
      return run(store, 'readonly', (s) => promisify(s.getAllKeys()));
    },
    async has(store, key) {
      return (await run(store, 'readonly', (s) => promisify(s.count(key)))) > 0;
    },
    async clear() {
      const tx = db.transaction(ALL_STORES, 'readwrite');
      for (const store of ALL_STORES) tx.objectStore(store).clear();
      await finished(tx);
    },
  };
}
