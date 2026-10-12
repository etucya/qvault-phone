// Background picture fetching: after a sync, pictures that questions name but the phone has
// not cached yet are downloaded a few at a time, at the lowest priority, and the loop stops
// the moment a study session starts. The core is pure so it can be tested with fakes.

export const PREFETCH_AT_ONCE = 3;

/** Every picture name the banks mention that `hasPicture(name)` says is not cached, once each, in library order. */
export function planPrefetch(banks, hasPicture) {
  const wanted = [];
  const seen = new Set();
  for (const bank of banks ?? []) {
    for (const question of bank?.questions ?? []) {
      const name = question?.image;
      if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
      seen.add(name);
      if (!hasPicture(name)) wanted.push(name);
    }
  }
  return wanted;
}

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Fetches `names` with at most `concurrency` in flight. Between items each worker yields to
 * the event loop, and it stops taking new names once `shouldStop()` is true (items already
 * in flight finish). `onProgress(remaining)` is called after every item. Never throws.
 * Resolves to {fetched, remaining, stopped}.
 */
export async function runPrefetch({
  names,
  fetchOne,
  concurrency = PREFETCH_AT_ONCE,
  shouldStop = () => false,
  onProgress = () => {},
  yieldFn = yieldToBrowser,
}) {
  let next = 0;
  let done = 0;
  let stopped = false;
  const total = names.length;

  const worker = async () => {
    while (next < total) {
      if (shouldStop()) {
        stopped = true;
        return;
      }
      const name = names[next];
      next += 1;
      try {
        await fetchOne(name);
      } catch {
        // A picture that cannot be had is tried again on the next sync.
      }
      done += 1;
      try {
        onProgress(total - done);
      } catch {
        // Progress is only a display.
      }
      await yieldFn();
    }
  };

  const workers = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: workers }, worker));
  return { fetched: done, remaining: total - done, stopped };
}
