// The library's Continue card (app/ui/continueLogic.js): when it shows, what it says, what
// resuming from it works from, and how startStudy remembers and forgets the last session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  continueCard, continuePlan, continueMeta, loadContinue, rememberSession, forgetSession, LAST_SESSION,
} from '../app/ui/continueLogic.js';
import { startStudy } from '../app/ui/setupLogic.js';
import { decodeSettings, encodeSettings } from '../app/engine/settings.js';
import { encodeState, decodeState } from '../app/engine/sessionEngine.js';
import { openStore } from '../app/store.js';
import { memoryAdapter } from '../app/storeMemory.js';

const at = (seconds) => new Date(seconds * 1000);
const fixed = () => at(1_000_000);
const first = () => 0;

const q = (id, tags = []) => ({
  id, type: 'mcq', prompt: `Prompt ${id}`, answer: 'A', keywords: [], tags, flagged: false,
  options: [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }],
  stats: { attempts: [] },
});
const bank = (path, questions) => ({ path, name: path.replace(/\.quiz$/, ''), md5: 'x', questions });
const summary = (path, extra = {}) => ({ path, name: path.replace(/\.quiz$/, ''), questionCount: 3, ...extra });

function savedSession(ids, fields = {}) {
  return encodeState({
    startedAt: at(100), settings: decodeSettings(fields), queue: ids, position: 0, retired: [],
    missed: [], streaks: {}, availableAt: {}, answered: 0, activeMs: 0,
  });
}

async function storeWith(banks) {
  const store = await openStore(memoryAdapter());
  for (const b of banks) await store.banks.put(b);
  return store;
}

const POOL = 'pool:a.quiz|b.quiz';
const pooled = { key: POOL, title: '2 banks', paths: ['a.quiz', 'b.quiz'], startedAt: '2026-10-14T10:00:00.000Z' };

// ---------------------------------------------------------------------------------------
// The card

test('the card shows while the session exists: title, queue length as remaining, no tags', () => {
  const card = continueCard({ lastSession: pooled, session: savedSession(['1', '2', '3']), banks: [summary('a.quiz'), summary('b.quiz')] });
  assert.deepEqual(card, { title: '2 banks', remaining: 3, tags: [] });
  assert.equal(continueMeta(card), '3 to go');
});

test('a single bank shows its name', () => {
  const last = { key: 'Bio/a.quiz', title: 'a', paths: ['Bio/a.quiz'], startedAt: 'x' };
  const card = continueCard({ lastSession: last, session: savedSession(['1']), banks: [summary('Bio/a.quiz', { name: 'Cells' })] });
  assert.equal(card.title, 'Cells');
});

test('the card is hidden when the session is gone or has nothing left', () => {
  const banks = [summary('a.quiz'), summary('b.quiz')];
  assert.equal(continueCard({ lastSession: pooled, session: null, banks }), null);
  assert.equal(continueCard({ lastSession: pooled, session: savedSession([]), banks }), null);
  assert.equal(continueCard({ lastSession: null, session: savedSession(['1']), banks }), null);
});

test('the card is hidden when none of its banks remain', () => {
  const banks = [summary('c.quiz'), summary('a.quiz', { corrupt: true })];
  assert.equal(continueCard({ lastSession: pooled, session: savedSession(['1']), banks }), null);
});

test('the tag filter is listed, from the session, else the stored settings', () => {
  const banks = [summary('a.quiz'), summary('b.quiz')];
  const card = continueCard({ lastSession: pooled, session: savedSession(['1', '2'], { tags: ['Lec 1', 'TQ'] }), banks });
  assert.deepEqual(card.tags, ['Lec 1', 'TQ']);
  assert.equal(continueMeta(card), '2 to go · Lec 1, TQ only');
  const session = savedSession(['1']);
  delete session.settings;
  const fromSettings = continueCard({ lastSession: pooled, session, banks, settings: encodeSettings(decodeSettings({ tags: ['TQ'] })) });
  assert.equal(continueMeta(fromSettings), '1 to go · TQ only');
});

test('with one pooled bank gone the card names what is left', () => {
  const card = continueCard({ lastSession: pooled, session: savedSession(['1']), banks: [summary('b.quiz')] });
  assert.equal(card.title, 'b');
});

// ---------------------------------------------------------------------------------------
// The resume plan

test('the plan keeps the remembered key and uses only banks that still exist, in library order', () => {
  const last = { ...pooled, key: 'pool:a.quiz|b.quiz|c.quiz', paths: ['c.quiz', 'a.quiz', 'b.quiz'] };
  const plan = continuePlan({ lastSession: last, banks: [summary('a.quiz'), summary('b.quiz', { corrupt: true }), summary('c.quiz'), summary('d.quiz')] });
  assert.deepEqual(plan, { key: 'pool:a.quiz|b.quiz|c.quiz', paths: ['a.quiz', 'c.quiz'] });
  assert.equal(continuePlan({ lastSession: last, banks: [summary('d.quiz')] }), null);
});

test('loadContinue gives the card with its plan, and forgets a session none of whose banks remain', async () => {
  const store = await storeWith([bank('a.quiz', [q('a1')]), bank('b.quiz', [q('b1')])]);
  assert.equal(await loadContinue(store, await store.banks.list()), null);
  await store.meta.put(LAST_SESSION, pooled);
  await store.sessions.put(POOL, savedSession(['a1', 'b1']));
  const card = await loadContinue(store, await store.banks.list());
  assert.deepEqual(card, { title: '2 banks', remaining: 2, tags: [], plan: { key: POOL, paths: ['a.quiz', 'b.quiz'] } });

  await store.banks.delete('a.quiz');
  await store.banks.delete('b.quiz');
  assert.equal(await loadContinue(store, await store.banks.list()), null);
  assert.equal(await store.meta.get(LAST_SESSION), null);
});

test('forgetSession with a key leaves another session remembered', async () => {
  const store = await storeWith([]);
  await rememberSession(store, { key: 'a.quiz', title: 'a', paths: ['a.quiz'], startedAt: at(0) });
  await forgetSession(store, 'b.quiz');
  assert.equal((await store.meta.get(LAST_SESSION)).key, 'a.quiz');
  await forgetSession(store, 'a.quiz');
  assert.equal(await store.meta.get(LAST_SESSION), null);
});

// ---------------------------------------------------------------------------------------
// Remembered by startStudy, forgotten when the session finishes

test('starting or resuming remembers the session; finishing it forgets it', async () => {
  const store = await storeWith([bank('b.quiz', [q('b1')]), bank('a.quiz', [q('a1')])]);
  const { model, flush } = await startStudy({
    store, paths: ['b.quiz', 'a.quiz'], settings: decodeSettings({ order: 'original' }), now: fixed, random: first,
  });
  assert.deepEqual(await store.meta.get(LAST_SESSION), {
    key: POOL, title: '2 banks', paths: ['a.quiz', 'b.quiz'], startedAt: fixed().toISOString(),
  });
  model.choose(model.current.answer);
  model.advance();
  await flush();
  assert.ok(await store.sessions.get(POOL), 'one to go: still saved');
  assert.ok(await store.meta.get(LAST_SESSION));
  model.choose(model.current.answer);
  await flush();
  assert.equal(await store.sessions.get(POOL), null);
  assert.equal(await store.meta.get(LAST_SESSION), null);
});

test('resuming from the card with a pooled bank gone keeps the pool session, pruned to what is left', async () => {
  const store = await storeWith([bank('b.quiz', [q('b1'), q('b2')])]);
  await store.meta.put(LAST_SESSION, pooled);
  await store.sessions.put(POOL, savedSession(['a1', 'b2', 'b1'], { order: 'original' }));
  const card = await loadContinue(store, await store.banks.list());
  assert.deepEqual(card.plan, { key: POOL, paths: ['b.quiz'] });

  const { model, key, flush } = await startStudy({
    store, paths: card.plan.paths, key: card.plan.key, settings: decodeSettings({ order: 'original' }),
    mode: 'resume', resumeOnly: true, now: fixed, random: first,
  });
  assert.equal(key, POOL);
  assert.equal(model.current.prompt, 'Prompt b1', 'the saved queue in CSV order, a1 pruned');
  model.choose(model.current.answer);
  await flush();
  assert.deepEqual(decodeState(await store.sessions.get(POOL)).queue, ['b2']);
  assert.equal((await store.meta.get(LAST_SESSION)).key, POOL);
});

test('resuming from the card when the session has since finished throws, and starts nothing', async () => {
  const store = await storeWith([bank('a.quiz', [q('1')])]);
  await assert.rejects(
    startStudy({ store, paths: ['a.quiz'], key: 'a.quiz', settings: decodeSettings({}), mode: 'resume', resumeOnly: true }),
    (error) => error.finished === true,
  );
  assert.equal(await store.sessions.get('a.quiz'), null);
  assert.equal(await store.meta.get(LAST_SESSION), null);
});

test('a pool session pruned to nothing on resume is deleted and forgotten', async () => {
  const store = await storeWith([bank('b.quiz', [q('b1')])]);
  await store.meta.put(LAST_SESSION, pooled);
  await store.sessions.put(POOL, savedSession(['a1']));
  await assert.rejects(startStudy({
    store, paths: ['b.quiz'], key: POOL, settings: decodeSettings({}), mode: 'resume', resumeOnly: true,
  }));
  assert.equal(await store.sessions.get(POOL), null);
  assert.equal(await store.meta.get(LAST_SESSION), null);
});
