import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summary, isTrouble, masteryBand, setSummary, lastStudied,
} from '../app/engine/stats.js';

/// Builds a question whose attempts are [outcome, chose] pairs, one per second.
function question(outcomes, ms = 1000, extra = {}) {
  return {
    id: 'q', type: 'mcq', prompt: 'P',
    options: [{ letter: 'A', text: 'a' }, { letter: 'B', text: 'b' }],
    answer: 'A',
    flagged: false,
    stats: {
      attempts: outcomes.map(([outcome, chose], index) => {
        const attempt = { at: new Date(index * 1000), outcome, ms };
        if (chose != null) attempt.chose = chose;
        return attempt;
      }),
    },
    ...extra,
  };
}

test('countsEachOutcomeSeparately', () => {
  const s = summary(question([
    ['correct', 'A'], ['shaky', 'A'], ['wrong', 'B'], ['dontknow', null],
  ]));
  assert.equal(s.seen, 4);
  assert.equal(s.correct, 2); // correct + shaky
  assert.equal(s.wrong, 1);
  assert.equal(s.shaky, 1);
  assert.equal(s.dontKnow, 1);
});

test('accuracyCountsShakyAsCorrectAndDontKnowAsWrong', () => {
  assert.equal(summary(question([['shaky', 'A'], ['dontknow', null]])).accuracy, 0.5);
});

test('accuracyIsNilForAnUnseenQuestion', () => {
  assert.equal(summary(question([])).accuracy, null);
  assert.equal(summary(question([])).averageMs, null);
});

test('averageTimeIsRoundedMilliseconds', () => {
  const q = question([['correct', null], ['wrong', null]]);
  q.stats.attempts[0].ms = 1000;
  q.stats.attempts[1].ms = 3001;
  // (1000 + 3001) / 2 = 2000.5, truncated by integer division.
  assert.equal(summary(q).averageMs, 2000);
});

test('averageTimeTruncatesRatherThanRounding', () => {
  const q = question([['correct', null], ['correct', null]]);
  q.stats.attempts[0].ms = 1;
  q.stats.attempts[1].ms = 2; // 1.5 would round to 2
  assert.equal(summary(q).averageMs, 1);
});

test('lastTimeIsTheMostRecentAttemptNotTheAverage', () => {
  const q = question([['correct', null], ['correct', null]]);
  q.stats.attempts[0].ms = 1000;
  q.stats.attempts[1].ms = 9000;
  const s = summary(q);
  assert.equal(s.averageMs, 5000);
  assert.equal(s.lastMs, 9000);
  assert.equal(summary(question([])).lastMs, null);
});

test('distractorBreakdownExcludesDontKnow', () => {
  const s = summary(question([
    ['wrong', 'B'], ['wrong', 'B'], ['dontknow', null], ['correct', 'A'],
  ]));
  assert.deepEqual(s.distractors, { B: 2 });
});

test('troubleNeedsAtLeastThreeAttempts', () => {
  assert.equal(isTrouble(question([['wrong', 'B'], ['wrong', 'B']])), false);
});

test('threeMissesMakesItTrouble', () => {
  assert.equal(isTrouble(question([['wrong', 'B'], ['wrong', 'B'], ['wrong', 'B']])), true);
});

test('lowAccuracyMakesItTrouble', () => {
  assert.equal(isTrouble(question([
    ['correct', 'A'], ['wrong', 'B'], ['wrong', 'B'], ['wrong', 'B'], ['wrong', 'B'],
  ])), true);
});

test('twoRepeatLatersMakeItTroubleEvenAtPerfectAccuracy', () => {
  // The rule that earns its place: never wrong, never actually known.
  const q = question([['correct', 'A'], ['shaky', 'A'], ['shaky', 'A']]);
  assert.equal(summary(q).accuracy, 1.0);
  assert.equal(isTrouble(q), true);
});

test('aRecentDontKnowMakesItTrouble', () => {
  assert.equal(isTrouble(question([['correct', 'A'], ['correct', 'A'], ['dontknow', null]])), true);
});

test('aSolidQuestionIsNotTrouble', () => {
  assert.equal(isTrouble(question([['correct', 'A'], ['correct', 'A'], ['correct', 'A']])), false);
});

// Beyond the Swift StatsTests: band order, set summary, last studied.

test('bandsAreEvaluatedInOrderNeverTroubleShakySolid', () => {
  assert.equal(masteryBand(question([])), 'never');
  assert.equal(masteryBand(question([['wrong', 'B'], ['wrong', 'B'], ['wrong', 'B']])), 'trouble');
  // One shaky is not trouble but still shaky.
  assert.equal(masteryBand(question([['correct', 'A'], ['shaky', 'A']])), 'shaky');
  // No shaky attempts, accuracy 3/4 = 0.75 < 0.8.
  assert.equal(masteryBand(question([
    ['correct', 'A'], ['correct', 'A'], ['correct', 'A'], ['wrong', 'B'],
  ])), 'shaky');
  // Exactly 0.8 is solid.
  assert.equal(masteryBand(question([
    ['correct', 'A'], ['correct', 'A'], ['correct', 'A'], ['correct', 'A'], ['wrong', 'B'],
  ])), 'solid');
  // A trouble question that also has shaky attempts is trouble, not shaky.
  assert.equal(masteryBand(question([['shaky', 'A'], ['shaky', 'A'], ['correct', 'A']])), 'trouble');
});

test('setSummaryCountsBandsFlagsAndPoolsAccuracy', () => {
  const never = question([]);
  const trouble = question([['wrong', 'B'], ['wrong', 'B'], ['wrong', 'B']], 1000, { flagged: true });
  const shaky = question([['correct', 'A'], ['shaky', 'A']]);
  const solid = question([['correct', 'A'], ['correct', 'A'], ['correct', 'A'], ['correct', 'A'], ['correct', 'A']]);
  const s = setSummary([never, trouble, shaky, solid]);
  assert.equal(s.total, 4);
  assert.equal(s.never, 1);
  assert.equal(s.trouble, 1);
  assert.equal(s.shaky, 1);
  assert.equal(s.solid, 1);
  assert.equal(s.flagged, 1);
  // Pooled: 0 + 2 + 5 correct over 3 + 2 + 5 attempts, not an average of rates.
  assert.equal(s.accuracy, 7 / 10);
  assert.equal(s.mastery, 0.25);
});

test('setSummaryOfNothingHasNullAccuracyAndZeroMastery', () => {
  const s = setSummary([]);
  assert.equal(s.total, 0);
  assert.equal(s.accuracy, null);
  assert.equal(s.mastery, 0);
  assert.equal(setSummary([question([])]).accuracy, null);
});

test('lastStudiedIsTheLatestAttemptAcrossQuestions', () => {
  const a = question([['correct', 'A']]);
  const b = question([['correct', 'A'], ['correct', 'A'], ['correct', 'A']]);
  assert.equal(lastStudied([a, b]).getTime(), 2000);
  assert.equal(lastStudied([question([])]), null);
  assert.equal(lastStudied([]), null);
});
