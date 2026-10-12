import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPrefetch, runPrefetch } from '../app/prefetch.js';

const bank = (...images) => ({ questions: images.map((image, i) => (image === undefined ? { id: `q${i}` } : { id: `q${i}`, image })) });

test('planPrefetch lists each uncached picture once, in library order', () => {
  const banks = [bank('a.png', undefined, 'b.png'), bank('b.png', 'c.png', 'a.png')];
  assert.deepEqual(planPrefetch(banks, () => false), ['a.png', 'b.png', 'c.png']);
  assert.deepEqual(planPrefetch(banks, (name) => name === 'b.png'), ['a.png', 'c.png']);
  assert.deepEqual(planPrefetch(banks, () => true), []);
  assert.deepEqual(planPrefetch([], () => false), []);
  assert.deepEqual(planPrefetch(null, () => false), []);
});

test('planPrefetch ignores empty and missing image fields', () => {
  assert.deepEqual(planPrefetch([{ questions: [{ image: '' }, { image: null }, {}] }, { }], () => false), []);
});

test('runPrefetch never has more than the concurrency in flight and fetches everything', async () => {
  const names = Array.from({ length: 10 }, (_, i) => `p${i}.png`);
  let inFlight = 0;
  let peak = 0;
  const fetched = [];
  const result = await runPrefetch({
    names,
    concurrency: 3,
    fetchOne: async (name) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      fetched.push(name);
    },
  });
  assert.equal(peak, 3);
  assert.deepEqual([...fetched].sort(), [...names].sort());
  assert.deepEqual(result, { fetched: 10, remaining: 0, stopped: false });
});

test('runPrefetch stops taking new names once shouldStop flips', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `p${i}.png`);
  let stop = false;
  const fetched = [];
  const result = await runPrefetch({
    names,
    concurrency: 3,
    shouldStop: () => stop,
    fetchOne: async (name) => {
      fetched.push(name);
      if (fetched.length === 4) stop = true;
    },
  });
  assert.ok(fetched.length >= 4 && fetched.length <= 4 + 2, `fetched ${fetched.length}`);
  assert.equal(result.stopped, true);
  assert.equal(result.remaining, names.length - fetched.length);
});

test('runPrefetch reports the remaining count after every item, ending at zero', async () => {
  const seen = [];
  await runPrefetch({
    names: ['a', 'b', 'c', 'd'],
    concurrency: 1,
    fetchOne: async () => {},
    onProgress: (remaining) => seen.push(remaining),
  });
  assert.deepEqual(seen, [3, 2, 1, 0]);
});

test('runPrefetch keeps going when one fetch throws, and with nothing to do resolves at once', async () => {
  const seen = [];
  const result = await runPrefetch({
    names: ['a', 'b', 'c'],
    fetchOne: async (name) => {
      if (name === 'b') throw new Error('nope');
    },
    onProgress: (r) => seen.push(r),
  });
  assert.equal(result.fetched, 3);
  assert.equal(seen.length, 3);
  assert.deepEqual(await runPrefetch({ names: [], fetchOne: async () => {} }), { fetched: 0, remaining: 0, stopped: false });
});

test('runPrefetch yields between items so it never holds the page', async () => {
  let yields = 0;
  await runPrefetch({
    names: ['a', 'b', 'c'],
    concurrency: 1,
    fetchOne: async () => {},
    yieldFn: async () => { yields += 1; },
  });
  assert.equal(yields, 3);
});
