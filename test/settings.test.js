import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, decodeSettings, encodeSettings, questionsTagged, scopedIDs,
} from '../app/engine/settings.js';
import { decodeState, encodeState } from '../app/engine/sessionEngine.js';

test('missing keys read as the defaults', () => {
  assert.deepEqual(decodeSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(decodeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(decodeSettings(null), DEFAULT_SETTINGS);
});

test('the defaults are the Mac defaults', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    scope: 'all', rangeLower: null, rangeUpper: null, order: 'shuffle',
    delay: { questions: 5 }, retireThreshold: 1, maxQuestions: null, tags: [],
    shuffleOptions: true,
  });
});

test('null values read as the defaults, as Swift decodeIfPresent does', () => {
  const s = decodeSettings({
    scope: null, rangeLower: null, order: null, delay: null, retireThreshold: null,
    maxQuestions: null, tags: null, shuffleOptions: null,
  });
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test('decoding returns a fresh object, never the shared defaults', () => {
  const s = decodeSettings({});
  s.tags.push('x');
  s.delay.questions = 9;
  assert.deepEqual(DEFAULT_SETTINGS.tags, []);
  assert.deepEqual(DEFAULT_SETTINGS.delay, { questions: 5 });
});

test('reads the Swift delay encoding for all three modes', () => {
  assert.deepEqual(decodeSettings({ delay: { questions: { _0: 7 } } }).delay, { questions: 7 });
  assert.deepEqual(decodeSettings({ delay: { minutes: { _0: 10 } } }).delay, { minutes: 10 });
  assert.deepEqual(decodeSettings({ delay: { endOfSet: {} } }).delay, { endOfSet: true });
});

test('reads the internal delay shape too', () => {
  assert.deepEqual(decodeSettings({ delay: { questions: 3 } }).delay, { questions: 3 });
  assert.deepEqual(decodeSettings({ delay: { minutes: 120 } }).delay, { minutes: 120 });
  assert.deepEqual(decodeSettings({ delay: { endOfSet: true } }).delay, { endOfSet: true });
});

test('writes the Swift delay encoding', () => {
  assert.deepEqual(encodeSettings(decodeSettings({ delay: { questions: 5 } })).delay,
    { questions: { _0: 5 } });
  assert.deepEqual(encodeSettings(decodeSettings({ delay: { minutes: 10 } })).delay,
    { minutes: { _0: 10 } });
  assert.deepEqual(encodeSettings(decodeSettings({ delay: { endOfSet: true } })).delay,
    { endOfSet: {} });
});

test('encoding leaves out the empty optionals', () => {
  const json = encodeSettings(DEFAULT_SETTINGS);
  assert.deepEqual(Object.keys(json).sort(),
    ['delay', 'order', 'retireThreshold', 'scope', 'shuffleOptions', 'tags']);
  assert.deepEqual(json, {
    delay: { questions: { _0: 5 } }, order: 'shuffle', retireThreshold: 1, scope: 'all',
    shuffleOptions: true, tags: [],
  });
});

test('encoding writes the optionals that are set', () => {
  const json = encodeSettings(decodeSettings({
    scope: 'range', rangeLower: 2, rangeUpper: 9, maxQuestions: 25,
  }));
  assert.equal(json.rangeLower, 2);
  assert.equal(json.rangeUpper, 9);
  assert.equal(json.maxQuestions, 25);
});

test('every setting round trips through the Swift encoding', () => {
  const settings = {
    scope: 'range', rangeLower: 3, rangeUpper: 12, order: 'original', delay: { minutes: 15 },
    retireThreshold: 3, maxQuestions: 50, tags: ['Lecture 2', 'Lecture 1'], shuffleOptions: false,
  };
  const decoded = decodeSettings(settings);
  const back = decodeSettings(JSON.parse(JSON.stringify(encodeSettings(decoded))));
  assert.deepEqual(back, decoded);
  assert.deepEqual(back.tags, ['Lecture 1', 'Lecture 2']);
  assert.equal(back.shuffleOptions, false);
});

test('a settings blob written by the Mac reads whole', () => {
  const mac = {
    delay: { endOfSet: {} }, maxQuestions: 25, order: 'original', retireThreshold: 2,
    scope: 'flagged', shuffleOptions: false, tags: ['B', 'A', 'B'],
  };
  assert.deepEqual(decodeSettings(mac), {
    scope: 'flagged', rangeLower: null, rangeUpper: null, order: 'original',
    delay: { endOfSet: true }, retireThreshold: 2, maxQuestions: 25, tags: ['A', 'B'],
    shuffleOptions: false,
  });
});

test('values the Mac could not read are refused rather than guessed', () => {
  assert.throws(() => decodeSettings({ scope: 'sometimes' }));
  assert.throws(() => decodeSettings({ order: 'backwards' }));
  assert.throws(() => decodeSettings({ delay: { hours: { _0: 1 } } }));
  assert.throws(() => decodeSettings({ delay: { questions: { _0: 1.5 } } }));
  assert.throws(() => decodeSettings({ retireThreshold: '2' }));
  assert.throws(() => decodeSettings({ tags: 'Lecture 1' }));
});

test('a negative delay is kept as written; the engine copes with it', () => {
  assert.deepEqual(decodeSettings({ delay: { questions: { _0: -5 } } }).delay, { questions: -5 });
});

// MARK: - Tags and scope

const q = (id, fields = {}) => ({
  id, type: 'tf', prompt: id, options: [], keywords: [], tags: [], flagged: false,
  stats: { attempts: [] }, ...fields,
});

test('questionsTagged keeps file order and matches any chosen tag', () => {
  const qs = [q('a', { tags: ['x'] }), q('b', { tags: ['y'] }), q('c', { tags: ['x', 'z'] })];
  assert.deepEqual(questionsTagged(qs, ['z', 'x']).map((x) => x.id), ['a', 'c']);
  assert.deepEqual(questionsTagged(qs, new Set(['y'])).map((x) => x.id), ['b']);
  assert.deepEqual(questionsTagged(qs, ['ghost']).map((x) => x.id), ['a', 'b', 'c']);
});

test('scopedIDs missed counts any wrong or dontknow ever, shaky is not a miss', () => {
  const at = new Date(0);
  const qs = [
    q('a', { stats: { attempts: [{ at, outcome: 'dontknow', ms: 1 }] } }),
    q('b', { stats: { attempts: [{ at, outcome: 'shaky', ms: 1 }] } }),
    q('c', { stats: { attempts: [{ at, outcome: 'wrong', ms: 1 }, { at, outcome: 'correct', ms: 1 }] } }),
    q('d'),
  ];
  assert.deepEqual(scopedIDs(qs, { scope: 'missed' }), ['a', 'c']);
  assert.deepEqual(scopedIDs(qs, { scope: 'unseen' }), ['d']);
});

test('scopedIDs range clamps and an inverted range is empty', () => {
  const qs = ['a', 'b', 'c', 'd'].map((id) => q(id));
  assert.deepEqual(scopedIDs(qs, { scope: 'range', rangeLower: 0, rangeUpper: 99 }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(scopedIDs(qs, { scope: 'range', rangeLower: 3 }), ['c', 'd']);
  assert.deepEqual(scopedIDs(qs, { scope: 'range', rangeUpper: 2 }), ['a', 'b']);
  assert.deepEqual(scopedIDs(qs, { scope: 'range', rangeLower: 4, rangeUpper: 2 }), []);
  assert.deepEqual(scopedIDs(qs, { scope: 'range', rangeLower: 9 }), []);
});

// MARK: - Session state

const savedState = {
  startedAt: '2026-09-02T14:36:12Z',
  settings: { delay: { minutes: { _0: 10 } }, order: 'original', retireThreshold: 2, scope: 'all', shuffleOptions: true, tags: [] },
  queue: ['q2', 'q1'],
  position: 1,
  retired: ['q3'],
  missed: ['q1'],
  streaks: { q1: 0 },
  availableAt: { q1: '2026-09-02T14:46:12Z' },
  answered: 3,
  activeMs: 81_000,
};

test('a saved state decodes with dates as Dates', () => {
  const state = decodeState(savedState);
  assert.deepEqual(state.startedAt, new Date('2026-09-02T14:36:12Z'));
  assert.deepEqual(state.availableAt.q1, new Date('2026-09-02T14:46:12Z'));
  assert.deepEqual(state.settings.delay, { minutes: 10 });
  assert.equal(state.activeMs, 81_000);
  assert.equal(state.position, 1);
});

test('a state saved without activeMs decodes to 0', () => {
  const { activeMs, ...older } = savedState;
  assert.equal(decodeState(older).activeMs, 0);
});

test('every other state key is required', () => {
  for (const key of ['startedAt', 'settings', 'queue', 'position', 'retired', 'missed', 'streaks', 'availableAt', 'answered']) {
    const broken = { ...savedState };
    delete broken[key];
    assert.throws(() => decodeState(broken), undefined, key);
  }
});

test('a state encodes back to exactly what the Mac wrote', () => {
  assert.deepEqual(encodeState(decodeState(savedState)), savedState);
});

test('encoded state dates have whole seconds', () => {
  const state = decodeState(savedState);
  state.startedAt = new Date('2026-09-02T14:36:12.987Z');
  state.availableAt.q1 = new Date('2026-09-02T14:46:12.001Z');
  const json = encodeState(state);
  assert.equal(json.startedAt, '2026-09-02T14:36:12Z');
  assert.equal(json.availableAt.q1, '2026-09-02T14:46:12Z');
});
