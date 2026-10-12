// The setup sheet's rules without the DOM (app/ui/setupLogic.js): keys, subtitle, counts,
// tags, range bounds, and what Start / Resume / Start fresh write through the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  settingsKey, tagOptions, pruneTags, taggedCount, inScopeCount, rangeBounds, effectiveSettings,
  recordedAnswers, subtitle, delayOf, loadSetup, startStudy,
} from '../app/ui/setupLogic.js';
import { decodeSettings, encodeSettings } from '../app/engine/settings.js';
import { encodeState, decodeState } from '../app/engine/sessionEngine.js';
import { openStore } from '../app/store.js';
import { memoryAdapter } from '../app/storeMemory.js';

const at = (seconds) => new Date(seconds * 1000);
const fixed = () => at(1_000_000);
const first = () => 0; // a "random" that keeps orders predictable

const q = (id, tags = [], extra = {}) => ({
  id, type: 'mcq', prompt: `Prompt ${id}`, answer: 'A', keywords: [], tags, flagged: false,
  options: [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }],
  stats: { attempts: [] },
  ...extra,
});
const attempt = (outcome = 'correct') => ({ at: at(500), outcome, ms: 1000, chose: 'A' });
const bank = (path, questions) => ({ path, name: path.replace(/\.quiz$/, ''), md5: 'x', questions });
const settings = (fields = {}) => decodeSettings(fields);
const wrong = (model) => (model.current.answer === 'A' ? 'B' : 'A');

async function storeWith(banks) {
  const store = await openStore(memoryAdapter());
  for (const b of banks) await store.banks.put(b);
  return store;
}

/** A saved session over `ids` (queue in that order), scope/tags as given. */
function savedSession(ids, fields = {}) {
  return encodeState({
    startedAt: at(100), settings: settings(fields), queue: ids, position: 0, retired: [],
    missed: [], streaks: {}, availableAt: {}, answered: 0, activeMs: 0,
  });
}

// ---------------------------------------------------------------------------------------
// Keys and text

test('a bank is keyed by its path; a pool by "pool:" and its paths sorted, joined with |', () => {
  assert.equal(settingsKey(['Bio/Cells.quiz']), 'Bio/Cells.quiz');
  assert.equal(settingsKey(['b.quiz', 'Bio/a.quiz', 'a.quiz']), 'pool:Bio/a.quiz|a.quiz|b.quiz');
});

test('the subtitle says "N questions" when everything is in scope', () => {
  assert.equal(subtitle({ total: 12, inScope: 12 }), '12 questions');
  assert.equal(subtitle({ total: 1, inScope: 1 }), '1 question');
});

test('the subtitle says "count of total" when the choices narrow it', () => {
  assert.equal(subtitle({ total: 12, inScope: 4 }), '4 of 12 questions');
  assert.equal(subtitle({ total: 12, inScope: 0 }), '0 of 12 questions');
});

test('with a saved session the subtitle adds how far from the end it stopped, counting the whole set while resuming', () => {
  assert.equal(subtitle({ total: 12, inScope: 4, resuming: true, remaining: 7 }), '12 questions · stopped with 7 questions to go');
  assert.equal(subtitle({ total: 12, inScope: 4, resuming: true, remaining: 1 }), '12 questions · stopped with 1 question to go');
  assert.equal(subtitle({ total: 12, inScope: 4, resuming: false, remaining: 7 }), '4 of 12 questions · stopped with 7 questions to go');
});

// ---------------------------------------------------------------------------------------
// Tags, counts, range

const tagged = [q('1', ['Lec 2']), q('2', ['Lec 1', 'Lec 2']), q('3', ['Lec 1']), q('4'), q('5', ['Lec 1'])];

test('tag chips are alphabetical with how many questions carry each', () => {
  assert.deepEqual(tagOptions(tagged), [{ name: 'Lec 1', count: 3 }, { name: 'Lec 2', count: 2 }]);
  assert.deepEqual(tagOptions([q('1', ['x', 'x'])]), [{ name: 'x', count: 1 }]);
  assert.deepEqual(tagOptions([q('1')]), []);
});

test('tags no question carries are pruned', () => {
  const pruned = pruneTags(settings({ tags: ['Gone', 'Lec 1'] }), tagged);
  assert.deepEqual(pruned.tags, ['Lec 1']);
});

test('picking tags narrows the in-scope count, on top of the scope', () => {
  assert.equal(inScopeCount(tagged, settings()), 5);
  assert.equal(inScopeCount(tagged, settings({ tags: ['Lec 1'] })), 3);
  assert.equal(inScopeCount(tagged, settings({ tags: ['Lec 1', 'Lec 2'] })), 4);
  const seen = tagged.map((x) => (x.id === '3' ? { ...x, stats: { attempts: [attempt()] } } : x));
  assert.equal(inScopeCount(seen, settings({ tags: ['Lec 1'], scope: 'unseen' })), 2);
});

test("the range's upper bound follows the tagged count", () => {
  assert.deepEqual(rangeBounds(tagged, settings({ scope: 'range' })), { lower: 1, upper: 5, max: 5 });
  assert.equal(taggedCount(tagged, settings({ tags: ['Lec 2'] })), 2);
  // An end picked before the tags narrowed shows clamped to what is left.
  assert.deepEqual(rangeBounds(tagged, settings({ scope: 'range', rangeLower: 2, rangeUpper: 5, tags: ['Lec 2'] })), { lower: 2, upper: 2, max: 2 });
  assert.equal(inScopeCount(tagged, settings({ scope: 'range', rangeLower: 2, rangeUpper: 5, tags: ['Lec 2'] })), 1);
  // A start left above the new end is read as the end, so the count matches the steppers.
  const stale = settings({ scope: 'range', rangeLower: 4, rangeUpper: 5, tags: ['Lec 1'] });
  assert.deepEqual(rangeBounds(tagged, stale), { lower: 3, upper: 3, max: 3 });
  assert.equal(inScopeCount(tagged, effectiveSettings(tagged, stale)), 1);
});

test('recorded answers count every attempt', () => {
  assert.equal(recordedAnswers([q('1', [], { stats: { attempts: [attempt(), attempt('wrong')] } }), q('2')]), 2);
});

test('the repeat delay stays within 1–99 questions and 1–120 minutes', () => {
  assert.deepEqual(delayOf('questions', 0), { questions: 1 });
  assert.deepEqual(delayOf('questions', 150), { questions: 99 });
  assert.deepEqual(delayOf('minutes', 500), { minutes: 120 });
  assert.deepEqual(delayOf('minutes'), { minutes: 10 });
  assert.deepEqual(delayOf('questions'), { questions: 5 });
  assert.deepEqual(delayOf('endOfSet', 3), { endOfSet: true });
});

// ---------------------------------------------------------------------------------------
// Loading

test('opening prunes dead tags from the stored settings and saves the pruned choice', async () => {
  const store = await storeWith([bank('a.quiz', tagged)]);
  await store.settings.put('a.quiz', encodeSettings(settings({ tags: ['Gone', 'Lec 2'], order: 'original' })));
  const setup = await loadSetup(store, ['a.quiz']);
  assert.deepEqual(setup.settings.tags, ['Lec 2']);
  assert.equal(setup.settings.order, 'original');
  assert.deepEqual(decodeSettings(await store.settings.get('a.quiz')).tags, ['Lec 2']);
  assert.equal(setup.title, 'a');
  assert.equal(setup.session, null);
});

test('unreadable stored settings fall back to the defaults', async () => {
  const store = await storeWith([bank('a.quiz', tagged)]);
  await store.settings.put('a.quiz', { scope: 'sideways' });
  assert.deepEqual((await loadSetup(store, ['a.quiz'])).settings, settings());
});

test('a pool is titled "N banks", keyed by its sorted paths, and pools in library order', async () => {
  const store = await storeWith([bank('b.quiz', [q('b1'), q('shared')]), bank('a.quiz', [q('a1'), q('shared')])]);
  const setup = await loadSetup(store, ['b.quiz', 'a.quiz']);
  assert.equal(setup.title, '2 banks');
  assert.equal(setup.key, 'pool:a.quiz|b.quiz');
  assert.deepEqual(setup.paths, ['a.quiz', 'b.quiz']);
  assert.deepEqual(setup.questions.map((x) => x.id), ['a1', 'shared', 'b1']);
});

// ---------------------------------------------------------------------------------------
// Start, resume, start fresh

test('start on a bank saves the settings and every answer goes back to the bank and its session', async () => {
  const store = await storeWith([bank('a.quiz', [q('1'), q('2'), q('3')])]);
  const chosen = settings({ order: 'original', shuffleOptions: false });
  const { model, key, title, flush } = await startStudy({ store, paths: ['a.quiz'], settings: chosen, now: fixed, random: first });
  assert.equal(key, 'a.quiz');
  assert.equal(title, 'a');
  assert.equal(model.current.prompt, 'Prompt 1');
  assert.deepEqual(decodeSettings(await store.settings.get('a.quiz')), chosen);

  model.choose(model.current.answer);
  await flush();
  const stored = await store.banks.get('a.quiz');
  assert.equal(stored.questions[0].stats.attempts.length, 1);
  assert.equal(stored.md5, 'x', 'the rest of the bank is kept');
  const session = decodeState(await store.sessions.get('a.quiz'));
  assert.deepEqual(session.queue, ['2', '3']);
});

test('a finished session is deleted rather than saved', async () => {
  const store = await storeWith([bank('a.quiz', [q('1')])]);
  await store.sessions.put('a.quiz', savedSession(['1']));
  const { model, flush } = await startStudy({ store, paths: ['a.quiz'], settings: settings(), mode: 'resume', now: fixed, random: first });
  model.choose(model.current.answer);
  await flush();
  assert.equal(await store.sessions.get('a.quiz'), null);
});

test('resume keeps the saved scope and tags, whatever the sheet now says', async () => {
  const store = await storeWith([bank('a.quiz', tagged)]);
  await store.sessions.put('a.quiz', savedSession(['3', '5'], { scope: 'unseen', tags: ['Lec 1'] }));
  const chosen = settings({ scope: 'all', tags: ['Lec 2'], order: 'original', retireThreshold: 2 });
  const { model, flush } = await startStudy({ store, paths: ['a.quiz'], settings: chosen, mode: 'resume', now: fixed, random: first });
  assert.equal(model.current.prompt, 'Prompt 3');
  model.choose(model.current.answer);
  await flush();
  const session = decodeState(await store.sessions.get('a.quiz'));
  assert.equal(session.settings.scope, 'unseen');
  assert.deepEqual(session.settings.tags, ['Lec 1']);
  assert.equal(session.settings.retireThreshold, 2, 'the rest comes from the sheet');
});

test('start fresh erases every answer in the bank and the saved session, then starts', async () => {
  const answered = [q('1', [], { stats: { attempts: [attempt()] } }), q('2', [], { stats: { attempts: [attempt('wrong'), attempt()] } }), q('3')];
  const store = await storeWith([bank('a.quiz', answered)]);
  await store.sessions.put('a.quiz', savedSession(['2']));
  const { model } = await startStudy({ store, paths: ['a.quiz'], settings: settings({ order: 'original' }), mode: 'fresh', now: fixed, random: first });
  const stored = await store.banks.get('a.quiz');
  assert.equal(recordedAnswers(stored.questions), 0);
  assert.equal(await store.sessions.get('a.quiz'), null);
  assert.equal(model.current.prompt, 'Prompt 1', 'a new queue over the whole bank');
});

test('start fresh on a pool erases every pooled bank and the pool session', async () => {
  const store = await storeWith([
    bank('a.quiz', [q('a1', [], { stats: { attempts: [attempt()] } })]),
    bank('b.quiz', [q('b1', [], { stats: { attempts: [attempt()] } })]),
    bank('c.quiz', [q('c1', [], { stats: { attempts: [attempt()] } })]),
  ]);
  await store.sessions.put('pool:a.quiz|b.quiz', savedSession(['a1']));
  await startStudy({ store, paths: ['a.quiz', 'b.quiz'], settings: settings(), mode: 'fresh', now: fixed, random: first });
  assert.equal(recordedAnswers((await store.banks.get('a.quiz')).questions), 0);
  assert.equal(recordedAnswers((await store.banks.get('b.quiz')).questions), 0);
  assert.equal(recordedAnswers((await store.banks.get('c.quiz')).questions), 1, 'banks outside the pool are untouched');
  assert.equal(await store.sessions.get('pool:a.quiz|b.quiz'), null);
});

test('a pool writes each answer back to the bank that owns the question and the session under the pool key', async () => {
  const store = await storeWith([bank('b.quiz', [q('b1'), q('shared')]), bank('a.quiz', [q('a1'), q('shared')])]);
  const { model, key, title, flush } = await startStudy({
    store, paths: ['b.quiz', 'a.quiz'], settings: settings({ order: 'original' }), now: fixed, random: first,
  });
  assert.equal(key, 'pool:a.quiz|b.quiz');
  assert.equal(title, '2 banks');
  model.choose(model.current.answer); // a1
  model.advance();
  model.choose(wrong(model)); // shared, owned by a.quiz (first in library order)
  model.advance();
  model.choose(model.current.answer); // b1
  await flush();
  const a = await store.banks.get('a.quiz');
  const b = await store.banks.get('b.quiz');
  assert.deepEqual(a.questions.map((x) => x.stats.attempts.map((t) => t.outcome)), [['correct'], ['wrong']]);
  assert.deepEqual(b.questions.map((x) => x.stats.attempts.map((t) => t.outcome)), [['correct'], []]);
  const session = decodeState(await store.sessions.get(key));
  assert.deepEqual(session.queue, ['shared']);
  assert.equal(await store.sessions.get('a.quiz'), null, 'no session under a single bank');
});

test('a failed write is reported, not thrown', async () => {
  const store = await storeWith([bank('a.quiz', [q('1'), q('2')])]);
  const errors = [];
  const { model, flush } = await startStudy({
    store, paths: ['a.quiz'], settings: settings(), now: fixed, random: first, onSaveError: (e) => errors.push(e.message),
  });
  store.banks.put = async () => { throw new Error('disk full'); };
  model.choose(model.current.answer);
  await flush();
  assert.deepEqual(errors, ['disk full']);
});

// ---------------------------------------------------------------------------------------
// Sessions over questions a sync took away

test('opening a pool prunes its saved session of questions no longer in any pooled bank, and saves it so', async () => {
  // a2 was deleted from a.quiz on the Mac and synced away; the pool session still names it.
  const store = await storeWith([bank('a.quiz', [q('a1')]), bank('b.quiz', [q('b1')])]);
  const key = 'pool:a.quiz|b.quiz';
  const saved = savedSession(['a2', 'b1', 'a1']);
  saved.position = 2;
  saved.missed = ['a2'];
  saved.streaks = { a2: 1 };
  await store.sessions.put(key, saved);

  const setup = await loadSetup(store, ['a.quiz', 'b.quiz']);
  assert.deepEqual(setup.session.queue, ['b1', 'a1']);
  assert.equal(setup.session.position, 1, 'the cursor stays on the same question');
  assert.deepEqual(setup.session.missed, []);
  assert.deepEqual(setup.session.streaks, {});
  const stored = decodeState(await store.sessions.get(key));
  assert.deepEqual(stored.queue, ['b1', 'a1']);
  assert.equal(stored.position, 1);
});

test('resuming a pool whose session named a vanished question starts on a live question', async () => {
  const store = await storeWith([bank('a.quiz', [q('a1')]), bank('b.quiz', [q('b1')])]);
  await store.sessions.put('pool:a.quiz|b.quiz', savedSession(['gone', 'b1']));
  const { model } = await startStudy({ store, paths: ['a.quiz', 'b.quiz'], settings: settings(), mode: 'resume', now: fixed, random: first });
  assert.equal(model.current.id, 'b1');
  assert.equal(model.isFinished(), false);
});

test('a session that is already clean is not written again', async () => {
  const store = await storeWith([bank('a.quiz', [q('a1')]), bank('b.quiz', [q('b1')])]);
  await store.sessions.put('pool:a.quiz|b.quiz', savedSession(['b1', 'a1']));
  let writes = 0;
  const put = store.sessions.put;
  store.sessions.put = async (...args) => { writes += 1; return put(...args); };
  const setup = await loadSetup(store, ['a.quiz', 'b.quiz']);
  assert.deepEqual(setup.session.queue, ['b1', 'a1']);
  assert.equal(writes, 0);
});

test('a session left with nothing to ask after pruning is finished: deleted, and no Resume', async () => {
  const store = await storeWith([bank('a.quiz', [q('a1')]), bank('b.quiz', [q('b1')])]);
  await store.sessions.put('pool:a.quiz|b.quiz', savedSession(['gone1', 'gone2']));
  const setup = await loadSetup(store, ['a.quiz', 'b.quiz']);
  assert.equal(setup.session, null);
  assert.equal(await store.sessions.get('pool:a.quiz|b.quiz'), null);
});
