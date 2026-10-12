// Ported from QVault/Tests/QVaultKitTests/SessionEngineTests.swift (48 tests) and
// SessionUndoTests.swift (9 tests). Names match the Swift ones, camelCase as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startSession, resumeSession, createEngine, remaining, clearedCount, totalCount, progress,
} from '../app/engine/sessionEngine.js';
import {
  decodeSettings, encodeSettings, questionsTagged, scopedIDs,
} from '../app/engine/settings.js';
import { encodeSet, decodeSet } from '../app/engine/quiz.js';

/// Repeatable randomness (SplitMix32), so a shuffle test fails the same way every time.
function splitMix(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9E3779B9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35) >>> 0;
    z = (z ^ (z >>> 16)) >>> 0;
    return z / 4294967296;
  };
}

/// A question as decodeSet would produce it: every defaulted field present.
function question(fields) {
  return {
    options: [], keywords: [], tags: [], flagged: false, stats: { attempts: [] }, ...fields,
  };
}

function quizSet(name, questions, extra = {}) {
  const at = new Date(1_000_000_000);
  return { schema: 1, name, created: at, modified: at, questions, ...extra };
}

/// Swift `makeSet(_:)`: q1…qn, open questions.
function fixture(n, prompt = 'Question') {
  return quizSet('T', Array.from({ length: n }, (_, i) => question({
    id: `q${i + 1}`, type: 'open', prompt: `${prompt} ${i + 1}`, answerText: 'A',
  })));
}

function engine(count, {
  delay = { questions: 2 }, threshold = 2, scope = 'all', maxQuestions = null,
  set = null, now = new Date(),
} = {}) {
  return startSession(
    set ?? fixture(count),
    { scope, order: 'original', delay, retireThreshold: threshold, maxQuestions },
    now,
  );
}

const byID = (e, id) => e.set.questions.find((q) => q.id === id);
const correctCount = (q) => q.stats.attempts
  .filter((a) => a.outcome === 'correct' || a.outcome === 'shaky').length;

// MARK: - SessionEngineTests

test('correctFirstTimeRetiresImmediately', () => {
  const e = engine(3);
  assert.equal(e.current()?.id, 'q1');

  const result = e.answer('correct', null, 100);
  assert.ok(result.retired);
  assert.ok(!result.requeued);
  assert.equal(e.current()?.id, 'q2');
  assert.equal(e.state.queue.length, 2);
});

test('wrongAnswerReturnsAfterTheConfiguredGap', () => {
  const e = engine(5, { delay: { questions: 2 } });
  e.answer('wrong', 'B', 100);
  assert.deepEqual(e.state.queue, ['q2', 'q3', 'q1', 'q4', 'q5']);
  assert.equal(e.current()?.id, 'q2');
});

test('aMissedQuestionMustClearTheThreshold', () => {
  const e = engine(3, { delay: { questions: 1 }, threshold: 2 });
  e.answer('wrong', null, 10);
  assert.ok(e.state.queue.includes('q1'));

  while (e.current()?.id !== 'q1') e.answer('correct', null, 10);
  e.answer('correct', null, 10);
  assert.ok(e.state.queue.includes('q1'));

  while (e.current()?.id !== 'q1') e.answer('correct', null, 10);
  e.answer('correct', null, 10);
  assert.ok(!e.state.queue.includes('q1'));
});

test('wrongAnswerResetsTheStreakSoALuckyGuessCannotRetire', () => {
  const e = engine(3, { delay: { questions: 1 }, threshold: 2 });
  e.answer('wrong', null, 10);
  while (e.current()?.id !== 'q1') e.answer('correct', null, 10);
  e.answer('correct', null, 10);
  assert.equal(e.state.streaks.q1, 1);

  while (e.current()?.id !== 'q1') e.answer('correct', null, 10);
  e.answer('wrong', null, 10);
  assert.equal(e.state.streaks.q1, 0);
  assert.ok(e.state.queue.includes('q1'));
});

test('repeatLaterRequeuesACorrectAnswerAndDiscardsProgress', () => {
  const e = engine(3, { delay: { questions: 1 }, threshold: 2 });
  const result = e.answer('shaky', null, 10);

  assert.ok(!result.retired);
  assert.ok(result.requeued);
  assert.ok(e.state.queue.includes('q1'));
  assert.equal(e.state.streaks.q1, 0);
  assert.ok(e.state.missed.includes('q1'));
});

test('repeatLaterCountsAsCorrectInTheRecord', () => {
  const e = engine(2);
  e.answer('shaky', null, 10);
  const q1 = byID(e, 'q1');
  assert.equal(q1.stats.attempts.at(-1)?.outcome, 'shaky');
  assert.equal(correctCount(q1), 1);
});

test('dontKnowActsLikeWrongButRecordsNoChosenOption', () => {
  const e = engine(3);
  e.answer('dontknow', 'C', 10);
  const q1 = byID(e, 'q1');

  assert.equal(q1.stats.attempts.at(-1)?.outcome, 'dontknow');
  assert.equal(q1.stats.attempts.at(-1)?.chose, undefined);
  assert.equal(correctCount(q1), 0);
  assert.ok(e.state.missed.includes('q1'));
  assert.ok(e.state.queue.includes('q1'));
});

test('requeueLandsAtTheEndWhenTheQueueIsShorterThanTheGap', () => {
  const e = engine(2, { delay: { questions: 10 } });
  e.answer('wrong', null, 10);
  assert.deepEqual(e.state.queue, ['q2', 'q1']);
});

test('endOfSetModeSendsMissesToTheBack', () => {
  const e = engine(4, { delay: { endOfSet: true } });
  e.answer('wrong', null, 10);
  assert.deepEqual(e.state.queue, ['q2', 'q3', 'q4', 'q1']);
});

test('minutesModeSkipsQuestionsThatAreNotDueYet', () => {
  const start = new Date(0);
  const e = engine(2, { delay: { minutes: 10 } });
  e.answer('wrong', null, 10, start);

  assert.equal(e.current()?.id, 'q2');

  e.answer('wrong', null, 10, start);
  assert.notEqual(e.current(), null);
});

test('sessionFinishesWhenEveryQuestionRetires', () => {
  const e = engine(3);
  e.answer('correct', null, 10);
  e.answer('correct', null, 10);
  const last = e.answer('correct', null, 10);

  assert.ok(last.finished);
  assert.ok(e.isFinished());
  assert.equal(e.current(), null);
});

test('lengthCapEndsTheSessionEarly', () => {
  const e = engine(10, { maxQuestions: 2 });
  e.answer('correct', null, 10);
  const second = e.answer('correct', null, 10);
  assert.ok(second.finished);
  assert.ok(e.isFinished());
});

test('repeatingCountReportsWhatIsWaitingToComeBack', () => {
  const e = engine(5, { delay: { questions: 2 } });
  assert.equal(e.repeatingCount(), 0);
  e.answer('wrong', null, 10);
  e.answer('wrong', null, 10);
  assert.equal(e.repeatingCount(), 2);
});

test('scopeFiltersSelectTheRightQuestions', () => {
  const set = fixture(4);
  set.questions[0].stats.attempts = [{ at: new Date(), outcome: 'wrong', ms: 1 }];
  set.questions[1].flagged = true;
  set.questions[2].stats.attempts = [{ at: new Date(), outcome: 'correct', ms: 1 }];

  assert.deepEqual(engine(4, { scope: 'missed', set }).state.queue, ['q1']);
  assert.deepEqual(engine(4, { scope: 'flagged', set }).state.queue, ['q2']);
  assert.deepEqual(engine(4, { scope: 'unseen', set }).state.queue, ['q2', 'q4']);
  assert.equal(engine(4, { scope: 'all', set }).state.queue.length, 4);
});

test('rangeScopeUsesOneBasedInclusiveBounds', () => {
  const e = startSession(fixture(5), {
    scope: 'range', rangeLower: 2, rangeUpper: 4,
    order: 'original', delay: { questions: 2 }, retireThreshold: 2,
  });
  assert.deepEqual(e.state.queue, ['q2', 'q3', 'q4']);
});

test('skipMovesOnWithoutRecordingAnything', () => {
  const e = engine(3);
  e.skip();
  assert.equal(e.set.questions[0].stats.attempts.length, 0);
  assert.equal(e.state.queue.at(-1), 'q1');
  assert.equal(e.current()?.id, 'q2');
});

test('attemptRecordsOutcomeTimeAndChoice', () => {
  const e = engine(2);
  const now = new Date(1_000 * 1000);
  e.answer('wrong', 'B', 22_400, now);

  const attempt = e.set.questions[0].stats.attempts.at(-1);
  assert.equal(attempt.outcome, 'wrong');
  assert.equal(attempt.ms, 22_400);
  assert.equal(attempt.chose, 'B');
  assert.deepEqual(attempt.at, now);
});

test('stateSurvivesAJSONRoundTrip', () => {
  // Whole-second `now` on purpose: the file format keeps whole seconds only.
  const e = engine(4, { now: new Date(1_700_000_000 * 1000) });
  e.answer('wrong', null, 10);

  const set = { ...e.set, session: e.state };
  const data = JSON.stringify(encodeSet(set), null, 2);
  const reloaded = decodeSet(data);

  assert.deepEqual(reloaded.session, e.state);
});

test('persistableSetCarriesTheLiveSessionMidway', () => {
  const e = engine(4);
  e.answer('wrong', null, 10);

  assert.notEqual(e.persistableSet().session, null);
  assert.deepEqual(e.persistableSet().session, e.state);
});

test('persistableSetHasNoSessionOnceFinished', () => {
  const e = engine(1);
  e.answer('correct', null, 10);

  assert.ok(e.isFinished());
  assert.equal(e.persistableSet().session, null);
});

test('persistableSetRoundTripsThroughQuizFileToAResumedEngine', () => {
  // No file system on the phone: the round trip is through the .quiz JSON text.
  const fixedNow = new Date(1_700_000_000 * 1000);
  const e = engine(4, { now: fixedNow });
  e.answer('wrong', 'B', 10, fixedNow);

  const text = JSON.stringify(encodeSet(e.persistableSet()), null, 2);
  const loaded = decodeSet(text);

  assert.notEqual(loaded.session, undefined);
  const resumed = createEngine(loaded, loaded.session);

  assert.equal(resumed.current()?.id, e.current()?.id);
  assert.deepEqual(resumed.state, e.state);
});

test('toggleFlagFlipsTheNamedQuestionRegardlessOfCurrent', () => {
  const e = engine(3);
  e.answer('correct', null, 10);
  assert.equal(e.current()?.id, 'q2');

  const toggled = e.toggleFlag('q1');

  assert.ok(toggled);
  assert.equal(byID(e, 'q1').flagged, true);
  assert.equal(byID(e, 'q2').flagged, false);
});

test('toggleFlagTwiceReturnsToUnflagged', () => {
  const e = engine(2);
  e.toggleFlag('q2');
  e.toggleFlag('q2');

  assert.equal(byID(e, 'q2').flagged, false);
});

test('toggleFlagOnAnUnknownIDIsANoOp', () => {
  const e = engine(2);

  const toggled = e.toggleFlag('does-not-exist');

  assert.ok(!toggled);
  assert.ok(e.set.questions.every((q) => !q.flagged));
});

test('remainingCountsTheWholeQueueNotJustPastPosition', () => {
  const state = {
    startedAt: new Date(), settings: decodeSettings({}),
    queue: ['q1', 'q2', 'q3'], position: 2,
    retired: [], missed: [], streaks: {}, availableAt: {}, answered: 0, activeMs: 0,
  };

  assert.equal(remaining(state), 3);
});

test('sessionProgressCountsClearedAgainstWhatItStartedWith', () => {
  const e = engine(4, { delay: { questions: 1 }, threshold: 1 });

  assert.equal(totalCount(e.state), 4);
  assert.equal(clearedCount(e.state), 0);
  assert.equal(progress(e.state), 0);

  e.answer('correct', null, 10);
  assert.equal(clearedCount(e.state), 1);
  assert.equal(totalCount(e.state), 4);
  assert.equal(progress(e.state), 0.25);
});

test('repeatVisitsDoNotInflateSessionProgress', () => {
  const e = engine(3, { delay: { questions: 1 }, threshold: 2 });

  e.answer('wrong', null, 10);
  while (!e.isFinished()) e.answer('correct', null, 10);

  assert.ok(e.state.answered > totalCount(e.state));
  assert.equal(clearedCount(e.state), totalCount(e.state));
  assert.equal(progress(e.state), 1.0);
});

test('anEmptySessionReportsZeroProgressRatherThanDividingByNothing', () => {
  const e = engine(1, { threshold: 1 });
  e.answer('correct', null, 10);

  assert.ok(e.isFinished());
  assert.equal(progress(e.state), 1.0);
  assert.equal(progress({ queue: [], retired: [] }), 0);
});

// MARK: - Removing a question mid-session

function removalEngine(count) {
  return startSession(
    quizSet('T', Array.from({ length: count }, (_, i) => question({
      id: `q${i + 1}`, type: 'open', prompt: `Q${i + 1}`, answerText: 'a',
    }))),
    { order: 'original', delay: { questions: 2 }, retireThreshold: 2 },
  );
}

test('removingAQuestionTakesItOutOfTheSetAndTheQueue', () => {
  const e = removalEngine(4);

  assert.ok(e.removeQuestion('q3'));

  assert.deepEqual(e.set.questions.map((q) => q.id), ['q1', 'q2', 'q4']);
  assert.deepEqual(e.state.queue, ['q1', 'q2', 'q4']);
});

test('removingAQuestionLeavesNoTraceOfItInTheSessionState', () => {
  const e = removalEngine(3);
  e.answer('wrong', null, 10);
  while (e.current()?.id !== 'q1') e.answer('correct', null, 10);

  assert.ok(e.state.missed.includes('q1'));
  assert.ok(e.removeQuestion('q1'));

  assert.ok(!e.state.queue.includes('q1'));
  assert.ok(!e.state.missed.includes('q1'));
  assert.ok(!e.state.retired.includes('q1'));
  assert.equal(e.state.streaks.q1, undefined);
  assert.equal(e.state.availableAt.q1, undefined);
});

test('removingTheQuestionOnScreenServesTheNextOne', () => {
  const e = removalEngine(3);
  assert.equal(e.current()?.id, 'q1');

  e.removeQuestion('q1');

  assert.equal(e.current()?.id, 'q2');
});

test('removingAQuestionBehindTheCursorKeepsTheCursorOnTheSameQuestion', () => {
  const e = removalEngine(4);
  e.answer('correct', null, 10);
  assert.equal(e.current()?.id, 'q2');

  e.removeQuestion('q1');

  assert.equal(e.current()?.id, 'q2');
});

test('removingTheLastQuestionFinishesTheSession', () => {
  const e = removalEngine(1);

  e.removeQuestion('q1');

  assert.ok(e.isFinished());
  assert.equal(e.current(), null);
});

test('removingAQuestionDropsTheUndoStack', () => {
  const e = removalEngine(3);
  e.answer('correct', null, 10);
  assert.ok(e.canUndo());

  e.removeQuestion('q2');

  assert.ok(!e.canUndo());
});

test('removingSomethingThatIsNotThereChangesNothing', () => {
  const e = removalEngine(2);
  const before = structuredClone(e.state);

  assert.ok(!e.removeQuestion('nope'));
  assert.deepEqual(e.state, before);
  assert.equal(e.set.questions.length, 2);
});

// MARK: - Resuming under new settings

function resumableSet() {
  return quizSet('Resumable', Array.from({ length: 6 }, (_, i) => question({
    id: `q${i + 1}`, type: 'tf', prompt: `Statement ${i + 1}`, answer: 'TRUE',
  })), {
    session: {
      startedAt: new Date(),
      settings: decodeSettings({ order: 'original', delay: { questions: 3 }, retireThreshold: 2 }),
      queue: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
      position: 2,
      retired: [],
      missed: ['q2'],
      streaks: { q2: 1 },
      availableAt: {},
      answered: 4,
      activeMs: 0,
    },
  });
}

/// Feeds back the given values in turn — a stand-in for Swift's `shuffle: { $0.reversed() }`.
function scripted(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('resumingWithShuffleReordersWhatIsLeft', () => {
  const set = resumableSet();
  const saved = set.session;

  // With Fisher–Yates from the back, these draws pick j = 0, 1, 2, 2, 1: a reversal.
  const engine = resumeSession(
    set, saved, { order: 'shuffle' }, new Date(), scripted([0, 0.3, 0.6, 0.8, 0.9]),
  );

  assert.deepEqual(engine.state.queue, ['q6', 'q5', 'q4', 'q3', 'q2', 'q1']);
  assert.equal(engine.state.settings.order, 'shuffle');
  assert.equal(engine.current()?.id, 'q6');
});

test('resumingInFileOrderPutsTheQueueBackInFileOrder', () => {
  const set = resumableSet();
  set.session.queue = ['q5', 'q1', 'q4', 'q2'];
  set.session.position = 3;
  const saved = set.session;

  const engine = resumeSession(set, saved, { order: 'original' });

  assert.deepEqual(engine.state.queue, ['q1', 'q2', 'q4', 'q5']);
  assert.equal(engine.current()?.id, 'q1');
});

test('resumingAdoptsTheSettingsThatCanStillApply', () => {
  const set = resumableSet();
  const saved = set.session;

  const engine = resumeSession(set, saved, {
    scope: 'flagged', rangeLower: 2, rangeUpper: 3, order: 'original',
    delay: { endOfSet: true }, retireThreshold: 3, maxQuestions: 40,
  });

  assert.deepEqual(engine.state.settings.delay, { endOfSet: true });
  assert.equal(engine.state.settings.retireThreshold, 3);
  assert.equal(engine.state.settings.maxQuestions, 40);
  assert.equal(engine.state.settings.scope, 'all');
  assert.equal(engine.state.settings.rangeLower, null);
  assert.equal(engine.state.settings.rangeUpper, null);
});

test('resumingKeepsEverythingAlreadyEarned', () => {
  const set = resumableSet();
  const saved = set.session;

  const engine = resumeSession(set, saved, { order: 'shuffle' }, new Date(), splitMix(11));

  assert.equal(engine.state.answered, 4);
  assert.deepEqual(engine.state.missed, ['q2']);
  assert.equal(engine.state.streaks.q2, 1);
  assert.equal(engine.state.retired.length, 0);
  assert.deepEqual([...engine.state.queue].sort(), [...saved.queue].sort());
});

test('resumingUnderAMinuteDelaySkipsPastWhatIsStillWaiting', () => {
  const set = resumableSet();
  const now = new Date();
  set.session.settings.delay = { minutes: 5 };
  set.session.queue = ['q1', 'q2', 'q3'];
  set.session.availableAt = { q1: new Date(now.getTime() + 300_000) };
  const saved = set.session;

  const engine = resumeSession(set, saved, { order: 'original', delay: { minutes: 5 } }, now);

  assert.equal(engine.state.queue[0], 'q1');
  assert.equal(engine.current()?.id, 'q2');
});

// MARK: - Studying by tag

function taggedSet() {
  return quizSet('Tagged', [
    question({ id: 'a', type: 'tf', prompt: 'A', answer: 'TRUE', tags: ['Lecture 1'] }),
    question({ id: 'b', type: 'tf', prompt: 'B', answer: 'TRUE', tags: ['Lecture 2'] }),
    question({ id: 'c', type: 'tf', prompt: 'C', answer: 'TRUE', tags: ['Lecture 1', 'Lecture 2'] }),
    question({ id: 'd', type: 'tf', prompt: 'D', answer: 'TRUE', tags: [] }),
    question({ id: 'e', type: 'tf', prompt: 'E', answer: 'TRUE', tags: ['Lecture 3'] }),
  ]);
}

test('choosingTagsStudiesOnlyQuestionsCarryingOneOfThem', () => {
  const engine = startSession(taggedSet(), { order: 'original', tags: ['Lecture 1', 'Lecture 3'] });
  assert.deepEqual(engine.state.queue, ['a', 'c', 'e']);
});

test('choosingNoTagsStudiesEverything', () => {
  const engine = startSession(taggedSet(), { order: 'original' });
  assert.deepEqual(engine.state.queue, ['a', 'b', 'c', 'd', 'e']);
});

test('tagsNarrowTheScopeRatherThanReplacingIt', () => {
  const set = taggedSet();
  for (const id of ['b', 'c']) {
    set.questions.find((q) => q.id === id).stats.attempts
      .push({ at: new Date(), outcome: 'wrong', ms: 1000 });
  }
  const engine = startSession(set, { scope: 'missed', order: 'original', tags: ['Lecture 1'] });
  assert.deepEqual(engine.state.queue, ['c']);
});

test('aRangeCountsWithinTheChosenTags', () => {
  const first = startSession(taggedSet(), {
    scope: 'range', rangeLower: 1, rangeUpper: 1, order: 'original', tags: ['Lecture 2'],
  });
  assert.deepEqual(first.state.queue, ['b']);

  const second = startSession(taggedSet(), {
    scope: 'range', rangeLower: 2, rangeUpper: 2, order: 'original', tags: ['Lecture 2'],
  });
  assert.deepEqual(second.state.queue, ['c']);
});

test('theInScopeCountIsWhatTheSessionWouldBeBuiltFrom', () => {
  const set = taggedSet();
  set.questions[0].flagged = true;
  set.questions[1].flagged = true;
  const settings = { scope: 'flagged', tags: ['Lecture 1'] };

  const preview = scopedIDs(set.questions, settings);
  const engine = startSession(set, settings, new Date(), () => 0.5);

  assert.deepEqual(preview, ['a']);
  assert.deepEqual(engine.state.queue, preview);
  assert.equal(questionsTagged(set.questions, []).length, 5);
  assert.deepEqual(questionsTagged(set.questions, ['Lecture 2']).map((q) => q.id), ['b', 'c']);
});

test('resumingKeepsTheTagsTheSessionWasBuiltWith', () => {
  const set = taggedSet();
  set.session = {
    startedAt: new Date(),
    settings: decodeSettings({ order: 'original', tags: ['Lecture 1'] }),
    queue: ['a', 'c'],
    position: 0, retired: [], missed: [], streaks: {}, availableAt: {}, answered: 0, activeMs: 0,
  };
  const saved = set.session;
  const engine = resumeSession(set, saved, { order: 'original', tags: ['Lecture 3'] });
  assert.deepEqual(engine.state.settings.tags, ['Lecture 1']);
  assert.deepEqual(engine.state.queue, ['a', 'c']);
});

test('settingsWrittenBeforeTagsExistedStillDecode', () => {
  const json = '{"scope":"all","order":"shuffle","delay":{"questions":{"_0":5}},"retireThreshold":2}';
  const settings = decodeSettings(JSON.parse(json));
  assert.equal(settings.tags.length, 0);
  assert.equal(settings.retireThreshold, 2);
  assert.deepEqual(settings.delay, { questions: 5 });

  const roundTrip = decodeSettings(JSON.parse(JSON.stringify(
    encodeSettings(decodeSettings({ tags: ['Lecture 1', 'Lecture 2'] })),
  )));
  assert.deepEqual(new Set(roundTrip.tags), new Set(['Lecture 1', 'Lecture 2']));
});

test('aRememberedTagNoQuestionCarriesIsIgnored', () => {
  const alone = startSession(taggedSet(), { order: 'original', tags: ['Ghost'] });
  assert.deepEqual(alone.state.queue, ['a', 'b', 'c', 'd', 'e']);

  const mixed = startSession(taggedSet(), { order: 'original', tags: ['Ghost', 'Lecture 3'] });
  assert.deepEqual(mixed.state.queue, ['e']);
});

// MARK: - SessionUndoTests

const fixedNow = new Date(1_000_000 * 1000);

function undoEngine(count, threshold = 2) {
  return startSession(
    quizSet('T', Array.from({ length: count }, (_, i) => question({
      id: `q${i + 1}`, type: 'open', prompt: `Q${i + 1}`, answerText: 'A',
    }))),
    { order: 'original', delay: { questions: 2 }, retireThreshold: threshold },
    fixedNow,
  );
}

test('undoRestoresEverythingAnAnswerChanged', () => {
  const e = undoEngine(4);
  const queueBefore = [...e.state.queue];
  const currentBefore = e.current()?.id;

  e.answer('wrong', 'B', 500);
  assert.notDeepEqual(e.state.queue, queueBefore);

  assert.ok(e.undoLastAnswer());

  assert.deepEqual(e.state.queue, queueBefore);
  assert.equal(e.current()?.id, currentBefore);
  assert.equal(e.state.answered, 0);
  assert.equal(e.state.missed.length, 0);
  assert.equal(e.set.questions[0].stats.attempts.length, 0);
});

test('answeringAgainAfterUndoLeavesTheSameRecordAsAnsweringOnce', () => {
  const a = undoEngine(4);
  a.answer('wrong', 'B', 500, new Date(10_000));

  const b = undoEngine(4);
  b.answer('correct', null, 100, new Date(5_000));
  b.undoLastAnswer();
  b.answer('wrong', 'B', 500, new Date(10_000));

  assert.deepEqual(a.state, b.state);
  assert.deepEqual(a.set, b.set);
});

test('undoReversesARetirement', () => {
  const e = undoEngine(3);
  e.answer('correct', null, 10);
  assert.deepEqual(e.state.retired, ['q1']);

  assert.ok(e.undoLastAnswer());
  assert.equal(e.state.retired.length, 0);
  assert.ok(e.state.queue.includes('q1'));
  assert.equal(e.current()?.id, 'q1');
});

test('undoReversesRepeatLater', () => {
  const e = undoEngine(3);
  e.answer('shaky', null, 10);
  assert.ok(e.state.missed.includes('q1'));

  assert.ok(e.undoLastAnswer());
  assert.equal(e.state.missed.length, 0);
  assert.equal(e.state.streaks.q1, undefined);
  assert.equal(e.set.questions[0].stats.attempts.length, 0);
});

test('undoUnwindsTheWholeSession', () => {
  const e = undoEngine(4);
  e.answer('correct', null, 10);
  e.answer('wrong', null, 10);
  e.answer('correct', null, 10);

  while (e.undoLastAnswer()) { /* unwind */ }

  assert.equal(e.state.answered, 0);
  assert.deepEqual(e.state.queue, ['q1', 'q2', 'q3', 'q4']);
  assert.ok(e.set.questions.every((q) => q.stats.attempts.length === 0));
});

test('undoWithNothingToUndoIsHarmless', () => {
  const e = undoEngine(2);
  assert.ok(!e.canUndo());
  assert.ok(!e.undoLastAnswer());
  assert.deepEqual(e.state.queue, ['q1', 'q2']);
});

test('aCorruptNegativeDelayDoesNotCrash', () => {
  const e = startSession(
    quizSet('T', Array.from({ length: 3 }, (_, i) => question({
      id: `q${i + 1}`, type: 'open', prompt: `Q${i + 1}`, answerText: 'A',
    }))),
    { order: 'original', delay: { questions: -5 }, retireThreshold: 2 },
  );
  e.answer('wrong', null, 10);

  assert.equal(e.state.queue.length, 3);
  assert.deepEqual(e.state.queue, ['q2', 'q1', 'q3']);
  assert.equal(e.current()?.id, 'q2');
});

test('retiringClearsTheQuestionsTimer', () => {
  const e = startSession(
    quizSet('T', Array.from({ length: 2 }, (_, i) => question({
      id: `q${i + 1}`, type: 'open', prompt: `Q${i + 1}`, answerText: 'A',
    }))),
    { order: 'original', delay: { minutes: 10 }, retireThreshold: 1 },
  );
  e.answer('wrong', null, 10, new Date(0));
  assert.notEqual(e.state.availableAt.q1, undefined);

  while (e.current()?.id !== 'q1') e.answer('correct', null, 10, new Date(6_000_000));
  e.answer('correct', null, 10, new Date(6_000_000));

  assert.equal(e.state.availableAt.q1, undefined);
});

test('skipIsNotUndoable', () => {
  const e = undoEngine(3);
  e.skip();
  assert.ok(!e.canUndo());
});

// MARK: - Inventory rules the Swift tests cover only implicitly

test('aQuestionNeverMissedRetiresOnItsFirstCorrectAnswerWhateverTheThreshold', () => {
  const e = engine(3, { threshold: 3 });
  const result = e.answer('correct', null, 10);
  assert.ok(result.retired);
  assert.deepEqual(e.state.retired, ['q1']);
  assert.equal(e.state.streaks.q1, undefined);
});

test('theCapEndsTheSessionWithoutShorteningTheQueue', () => {
  const e = engine(10, { maxQuestions: 3 });
  assert.equal(e.state.queue.length, 10);
  e.answer('wrong', null, 10);
  e.answer('correct', null, 10);
  assert.ok(!e.isFinished());
  const third = e.answer('correct', null, 10);
  assert.ok(third.finished);
  assert.equal(e.current(), null);
  assert.equal(e.state.queue.length, 8);
  const after = e.answer('correct', null, 10);
  assert.deepEqual(after, { retired: false, requeued: false, finished: true });
  assert.equal(e.state.answered, 3);
});

test('aResumedSessionCountsTheCapAcrossSittings', () => {
  const set = resumableSet();
  const engine = resumeSession(set, set.session, { order: 'original', maxQuestions: 5 });
  assert.ok(!engine.isFinished());
  engine.answer('correct', null, 10);
  assert.ok(engine.isFinished());
});

test('minutesModeServesTheSoonestWhenEverythingIsWaiting', () => {
  const e = engine(3, { delay: { minutes: 10 } });
  e.answer('wrong', null, 10, new Date(0));        // q1 due at 600 s
  e.answer('wrong', null, 10, new Date(60_000));   // q2 due at 660 s
  e.answer('wrong', null, 10, new Date(30_000));   // q3 due at 630 s
  // All waiting at 30 s: q1 (600 s) is soonest.
  assert.equal(e.current()?.id, 'q1');
});

test('startShufflesWithTheGivenRandomness', () => {
  const settings = { order: 'shuffle' };
  const a = startSession(fixture(8), settings, new Date(), splitMix(3));
  const b = startSession(fixture(8), settings, new Date(), splitMix(3));
  assert.deepEqual(a.state.queue, b.state.queue);
  assert.deepEqual([...a.state.queue].sort(), fixture(8).questions.map((q) => q.id).sort());
});

test('theEngineDoesNotMutateTheSetItWasGiven', () => {
  const set = fixture(2);
  const e = startSession(set, { order: 'original' });
  e.answer('wrong', 'B', 10);
  e.toggleFlag('q2');
  assert.equal(set.questions[0].stats.attempts.length, 0);
  assert.equal(set.questions[1].flagged, false);
});

test('updateKeepsTheIDAndTheHistory', () => {
  const e = engine(2);
  e.answer('wrong', null, 10);
  assert.ok(e.update('q1', question({ id: 'other', type: 'open', prompt: 'Edited', answerText: 'B' })));
  const q1 = byID(e, 'q1');
  assert.equal(q1.prompt, 'Edited');
  assert.equal(q1.stats.attempts.length, 1);
  assert.equal(byID(e, 'other'), undefined);
  assert.ok(!e.update('nope', question({ id: 'nope', type: 'open', prompt: 'x' })));
});

test('recordActiveTimeNeverGoesNegative', () => {
  const e = engine(2);
  e.recordActiveTime(-5);
  assert.equal(e.state.activeMs, 0);
  e.recordActiveTime(12_345);
  assert.equal(e.state.activeMs, 12_345);
});

test('countsReportClearedRepeatingTotalAndRemaining', () => {
  const e = engine(4);
  e.answer('correct', null, 10);
  e.answer('wrong', null, 10);
  assert.deepEqual(e.counts(), { cleared: 1, repeating: 1, total: 4, remaining: 3 });
});
