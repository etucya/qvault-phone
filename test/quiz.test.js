import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSet, encodeSet } from '../app/engine/quiz.js';

const macFile = {
  created: '2026-09-01T09:00:00Z',
  modified: '2026-09-02T14:36:12Z',
  name: 'Cardio',
  questions: [
    {
      answer: 'B',
      explanation: 'Because.',
      flagged: true,
      id: '89f7913d37a999a1',
      image: 'heart.png',
      keywords: [],
      options: [{ letter: 'A', text: 'Serum' }, { letter: 'B', text: 'Plasma' }],
      prompt: 'Plasma is closest in composition to',
      stats: {
        attempts: [
          { at: '2026-09-02T14:30:00Z', chose: 'A', ms: 4200, outcome: 'wrong' },
          { at: '2026-09-02T14:31:00Z', ms: 900, outcome: 'dontknow' },
          { at: '2026-09-02T14:32:00Z', chose: 'B', ms: 1300, outcome: 'shaky' },
        ],
        correct: 1,
        seen: 3,
      },
      tags: ['Lecture 1'],
      type: 'mcq',
    },
    {
      answerText: 'Tiny living things',
      flagged: false,
      id: 'c524a10859015a60',
      keywords: ['living'],
      note: 'mine',
      options: [],
      prompt: 'What are microorganisms?',
      stats: { attempts: [], correct: 0, seen: 0 },
      tags: [],
      type: 'open',
    },
  ],
  schema: 1,
  session: {
    activeMs: 1000,
    answered: 1,
    availableAt: {},
    missed: [],
    position: 0,
    queue: ['c524a10859015a60'],
    retired: ['89f7913d37a999a1'],
    settings: { delay: { questions: { _0: 5 } }, order: 'shuffle', retireThreshold: 1, scope: 'all', shuffleOptions: true, tags: [] },
    startedAt: '2026-09-02T14:29:00Z',
    streaks: {},
  },
  source: 'cardio.csv',
};

test('a Mac file encodes back to exactly the same JSON', () => {
  const decoded = decodeSet(JSON.stringify(macFile));
  assert.deepEqual(encodeSet(decoded), macFile);
});

test('the encoded keys come out sorted, as the Mac writes them', () => {
  const text = JSON.stringify(encodeSet(decodeSet(macFile)), null, 2);
  assert.equal(text, JSON.stringify(macFile, null, 2));
});

test('decoded dates are Dates and seen/correct are not kept', () => {
  const set = decodeSet(macFile);
  assert.deepEqual(set.created, new Date('2026-09-01T09:00:00Z'));
  assert.deepEqual(set.questions[0].stats.attempts[0].at, new Date('2026-09-02T14:30:00Z'));
  assert.deepEqual(Object.keys(set.questions[0].stats), ['attempts']);
  assert.deepEqual(set.session.startedAt, new Date('2026-09-02T14:29:00Z'));
});

test('missing question fields read as their defaults', () => {
  const set = decodeSet({
    schema: 1, name: 'N', created: '2026-09-01T09:00:00Z', modified: '2026-09-01T09:00:00Z',
    questions: [{ id: 'x', type: 'tf', prompt: 'P', options: null, stats: { seen: 4 } }],
  });
  const [q] = set.questions;
  assert.deepEqual(q.options, []);
  assert.deepEqual(q.keywords, []);
  assert.deepEqual(q.tags, []);
  assert.equal(q.flagged, false);
  assert.deepEqual(q.stats, { attempts: [] });
  assert.equal('answer' in q, false);
  assert.equal('session' in set, false);
});

test('encoding always writes the required question keys and leaves out empty optionals', () => {
  const set = decodeSet({
    schema: 1, name: 'N', created: '2026-09-01T09:00:00Z', modified: '2026-09-01T09:00:00Z',
    questions: [{ id: 'x', type: 'open', prompt: 'P' }],
  });
  set.session = null;
  const json = encodeSet(set);
  assert.deepEqual(Object.keys(json), ['created', 'modified', 'name', 'questions', 'schema']);
  assert.deepEqual(Object.keys(json.questions[0]),
    ['flagged', 'id', 'keywords', 'options', 'prompt', 'stats', 'tags', 'type']);
  assert.deepEqual(json.questions[0].stats, { attempts: [], correct: 0, seen: 0 });
});

test('an attempt with no choice leaves out chose', () => {
  const set = decodeSet(macFile);
  set.questions[1].stats.attempts.push({ at: new Date('2026-09-03T10:00:00.750Z'), outcome: 'correct', ms: 10 });
  const attempt = encodeSet(set).questions[1].stats.attempts[0];
  assert.deepEqual(attempt, { at: '2026-09-03T10:00:00Z', ms: 10, outcome: 'correct' });
});

test('a file missing a required key is refused', () => {
  for (const key of ['schema', 'name', 'created', 'modified', 'questions']) {
    const broken = { ...macFile };
    delete broken[key];
    assert.throws(() => decodeSet(broken), undefined, key);
  }
  assert.throws(() => decodeSet({ ...macFile, questions: [{ id: 'x', type: 'essay', prompt: 'P' }] }));
  assert.throws(() => decodeSet({ ...macFile, questions: [{ type: 'tf', prompt: 'P' }] }));
  assert.throws(() => decodeSet('not json'));
});
