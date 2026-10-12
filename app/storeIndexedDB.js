// IndexedDB storage adapter. Same interface as storeMemory.js: get / put / delete /
// getAll / keys / has per named store, plus clear. Database `qvault`, version 1.
//
// iOS closes an idle page's database connection behind its back (after the app has sat in
// the background, or when storage is under pressure). A connection that has closed is
// marked dead and reopened on the next call; a call that fails because the connection went
// away underneath it is retried once on a fresh connection. Every operation here is a
// single get, put, delete or read-all, so running one twice is harmless.

const KEYED_STORES = ['sessions', 'pictures', 'settings', 'meta'];
const ALL_STORES = ['banks', ...KEYED_STORES];

// What a transaction on a closed or lost connection throws.
const CONNECTION_LOST = new Set(['InvalidStateError', 'UnknownError']);

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

/**
 * `options.onOpen(db)` is called with every connection opened (for tests that need to
 * close one underneath the adapter); the adapter itself is the same as ever.
 */
export async function indexedDBAdapter(name = 'qvault', { onOpen = () => {} } = {}) {
  let db = null;
  let dead = true;
  let opening = null; // the one open in flight, shared by concurrent callers

  async function open() {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const created = request.result;
      created.createObjectStore('banks', { keyPath: 'path' });
      for (const store of KEYED_STORES) created.createObjectStore(store);
    };
    const handle = await promisify(request);
    // The browser closed it (iOS does this to backgrounded pages), or another tab wants
    // a newer version: either way this connection is finished.
    handle.onclose = () => {
      if (db === handle) dead = true;
    };
    handle.onversionchange = () => {
      if (db === handle) dead = true;
      try {
        handle.close();
      } catch {
        // already closed
      }
    };
    db = handle;
    dead = false;
    onOpen(handle);
    return handle;
  }

  function connection() {
    if (db && !dead) return Promise.resolve(db);
    if (!opening) {
      const flight = open().finally(() => {
        if (opening === flight) opening = null;
      });
      opening = flight;
    }
    return opening;
  }

  /** Runs `work(db)`; if the connection was lost underneath it, reopens once and tries once more. */
  async function withDB(work) {
    const handle = await connection();
    try {
      return await work(handle);
    } catch (error) {
      if (!CONNECTION_LOST.has(error?.name)) throw error;
      if (db === handle) dead = true;
      return work(await connection());
    }
  }

  await connection();

  // Ask the browser not to evict our data. Fire and forget: opening never waits on it,
  // and failure or absence is fine.
  try {
    navigator.storage?.persist?.().catch(() => {});
  } catch {
    // ignored
  }

  const run = (store, mode, fn) =>
    withDB((handle) => {
      const tx = handle.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      // A failed request also aborts the transaction, which rejects below; keep the
      // request's own rejection from surfacing a second time as an unhandled one.
      if (typeof result?.catch === 'function') result.catch(() => {});
      return finished(tx).then(() => result);
    });

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
      await withDB((handle) => {
        const tx = handle.transaction(ALL_STORES, 'readwrite');
        for (const store of ALL_STORES) tx.objectStore(store).clear();
        return finished(tx);
      });
    },
  };
}
