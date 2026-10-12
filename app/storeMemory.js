// In-memory storage adapter, used by the tests. Values are cloned on the way in and out,
// like IndexedDB does, so callers cannot change stored data by accident.
//
// Adapter interface (shared with storeIndexedDB.js); every call is async:
//   get(store, key)        -> value, or null when the key is unknown
//   put(store, key, value) -> stores value under key, replacing any existing one
//   delete(store, key)     -> removes the key (no error when absent)
//   getAll(store)          -> array of every value in the store
//   keys(store)            -> array of every key in the store
//   has(store, key)        -> true when the key exists (never reads the value)
//   clear()                -> empties every store

export function memoryAdapter() {
  const stores = new Map();
  const of = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    async get(store, key) {
      const map = of(store);
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async put(store, key, value) {
      of(store).set(key, structuredClone(value));
    },
    async delete(store, key) {
      of(store).delete(key);
    },
    async getAll(store) {
      return [...of(store).values()].map((v) => structuredClone(v));
    },
    async keys(store) {
      return [...of(store).keys()];
    },
    async has(store, key) {
      return of(store).has(key);
    },
    async clear() {
      stores.clear();
    },
  };
}
