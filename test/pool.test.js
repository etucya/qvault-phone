import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, writeBack } from '../app/engine/pool.js';

function question(id, extra = {}) {
  return { id, type: 'open', prompt: `Prompt ${id}`, answer: 'a', flagged: false, stats: { attempts: [] }, ...extra };
}

function answered(q) {
  return { ...q, stats: { attempts: [...q.stats.attempts, { at: new Date(10_000), outcome: 'wrong', ms: 900 }] } };
}

function source(path, name, questions) {
  return { path, name, questions };
}

function twoBanks() {
  return [
    { path: 'A.quiz', name: 'A', questions: [question('a1'), question('a2')] },
    { path: 'B.quiz', name: 'B', questions: [question('b1')] },
  ];
}

// buildPool

test('poolsEverythingInTheGivenSourceOrder', () => {
  const pool = buildPool([
    source('A.quiz', 'A', [question('a1'), question('a2')]),
    source('B.quiz', 'B', [question('b1')]),
  ]);
  assert.deepEqual(pool.questions.map((q) => q.id), ['a1', 'a2', 'b1']);
});

test('studyOrderFollowsSourcesNotPaths', () => {
  const pool = buildPool([
    source('Z/Z.quiz', 'Z', [question('z1')]),
    source('A/A.quiz', 'A', [question('a1')]),
  ]);
  assert.deepEqual(pool.questions.map((q) => q.id), ['z1', 'a1']);
});

test('aQuestionInTwoBanksIsPooledOnceAndTheFirstSourceWins', () => {
  const first = question('same', { prompt: 'From A' });
  const second = question('same', { prompt: 'From B' });
  const pool = buildPool([
    source('A.quiz', 'A', [first]),
    source('B.quiz', 'B', [second]),
  ]);
  assert.equal(pool.questions.length, 1);
  assert.equal(pool.questions[0].prompt, 'From A');
  assert.equal(pool.origins.get('same'), 'A.quiz');
});

test('aDuplicateWithinOneBankIsAlsoPooledOnce', () => {
  const pool = buildPool([source('A.quiz', 'A', [question('x'), question('x'), question('y')])]);
  assert.deepEqual(pool.questions.map((q) => q.id), ['x', 'y']);
});

test('originsMapEachIdToItsBank', () => {
  const pool = buildPool([
    source('A.quiz', 'A', [question('a1')]),
    source('B.quiz', 'B', [question('b1')]),
  ]);
  assert.ok(pool.origins instanceof Map);
  assert.equal(pool.origins.get('a1'), 'A.quiz');
  assert.equal(pool.origins.get('b1'), 'B.quiz');
  assert.equal(pool.origins.size, 2);
});

test('aSingleBankTitleIsItsName', () => {
  assert.equal(buildPool([source('A.quiz', 'Anatomy', [question('a1')])]).title, 'Anatomy');
});

test('severalBanksTitleCountsThem', () => {
  const pool = buildPool([
    source('A.quiz', 'A', [question('a1')]),
    source('B.quiz', 'B', [question('b1')]),
    source('C.quiz', 'C', [question('c1')]),
  ]);
  assert.equal(pool.title, '3 sets');
});

test('aBankContributingNothingIsNotCountedInTheTitle', () => {
  const shared = question('same');
  const pool = buildPool([
    source('A.quiz', 'A', [shared]),
    source('B.quiz', 'B', [shared]),
    source('C.quiz', 'C', []),
  ]);
  assert.equal(pool.title, 'A');
});

test('anEmptyPoolIsEmptyRatherThanMissing', () => {
  const pool = buildPool([source('A.quiz', 'A', [])]);
  assert.deepEqual(pool.questions, []);
  assert.equal(pool.origins.size, 0);
});

test('aPoolCarriesNoSession', () => {
  const pool = buildPool([{ ...source('A.quiz', 'A', [question('a1')]), session: { queue: ['a1'] } }]);
  assert.equal('session' in pool, false);
});

// writeBack

test('writesOnlyTheBankHoldingTheChangedQuestion', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const changed = writeBack(pool, [answered(banks[0].questions[0]), banks[0].questions[1], banks[1].questions[0]], banks);
  assert.deepEqual(changed.map((b) => b.path), ['A.quiz']);
});

test('carriesTheAttemptIntoTheRightBank', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const changed = writeBack(pool, [banks[0].questions[0], banks[0].questions[1], answered(banks[1].questions[0])], banks);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].path, 'B.quiz');
  assert.equal(changed[0].questions.find((q) => q.id === 'b1').stats.attempts.length, 1);
});

test('aWriteBackThatChangesNothingReturnsNothing', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const copies = banks.flatMap((b) => b.questions).map((q) => structuredClone(q));
  assert.deepEqual(writeBack(pool, copies, banks), []);
});

test('aQuestionWithNoOriginIsSkipped', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const changed = writeBack(pool, [answered(question('ghost')), answered(banks[1].questions[0])], banks);
  assert.deepEqual(changed.map((b) => b.path), ['B.quiz']);
});

test('aQuestionNoLongerInItsBankIsSkipped', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  // a2 was removed from A.quiz after the pool was built.
  const shrunk = [{ ...banks[0], questions: [banks[0].questions[0]] }, banks[1]];
  const changed = writeBack(pool, [answered(banks[0].questions[1])], shrunk);
  assert.deepEqual(changed, []);
});

test('aQuestionWhoseOriginBankIsGoneIsSkipped', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const changed = writeBack(pool, [answered(banks[1].questions[0])], [banks[0]]);
  assert.deepEqual(changed, []);
});

test('replacesInPlaceKeepingTheBanksOwnQuestionOrder', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const changed = writeBack(pool, [answered(banks[0].questions[1])], banks);
  assert.deepEqual(changed[0].questions.map((q) => q.id), ['a1', 'a2']);
  assert.equal(changed[0].questions[0].stats.attempts.length, 0);
  assert.equal(changed[0].questions[1].stats.attempts.length, 1);
});

test('aChangeInAnyFieldCounts', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const flagged = { ...banks[0].questions[0], flagged: true };
  const noted = { ...banks[1].questions[0], note: 'remember' };
  const changed = writeBack(pool, [flagged, noted], banks);
  assert.deepEqual(changed.map((b) => b.path), ['A.quiz', 'B.quiz']);
});

test('attemptDatesAreComparedByTime', () => {
  const withAttempt = { ...question('a1'), stats: { attempts: [{ at: new Date(5000), outcome: 'correct', ms: 100 }] } };
  const banks = [{ path: 'A.quiz', name: 'A', questions: [withAttempt] }];
  const pool = buildPool(banks);
  const sameTime = { ...withAttempt, stats: { attempts: [{ at: new Date(5000), outcome: 'correct', ms: 100 }] } };
  assert.deepEqual(writeBack(pool, [sameTime], banks), []);
  const otherTime = { ...withAttempt, stats: { attempts: [{ at: new Date(6000), outcome: 'correct', ms: 100 }] } };
  assert.equal(writeBack(pool, [otherTime], banks).length, 1);
});

test('keyOrderDoesNotMakeAQuestionDiffer', () => {
  const banks = [{ path: 'A.quiz', name: 'A', questions: [{ id: 'a1', prompt: 'P', answer: 'x' }] }];
  const pool = buildPool(banks);
  assert.deepEqual(writeBack(pool, [{ answer: 'x', prompt: 'P', id: 'a1' }], banks), []);
});

test('eachBankKeepsItsOwnSessionAndOtherFields', () => {
  const session = { startedAt: '2026-01-01T00:00:00Z', queue: ['a1'] };
  const banks = [{ path: 'A.quiz', name: 'A', md5: 'abc', session, questions: [question('a1')] }];
  const pool = buildPool(banks);
  const [changed] = writeBack(pool, [answered(banks[0].questions[0])], banks);
  assert.deepEqual(changed.session, session);
  assert.equal(changed.md5, 'abc');
  assert.equal(changed.name, 'A');
});

test('inputBanksAreNotMutated', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const before = structuredClone(banks);
  const result = writeBack(pool, [answered(banks[0].questions[0])], banks);
  assert.deepEqual(banks, before);
  assert.notEqual(result[0], banks[0]);
  assert.notEqual(result[0].questions, banks[0].questions);
});

test('aDuplicateIdOnlyWritesBackToTheWinningBank', () => {
  const shared = question('same');
  const banks = [
    { path: 'A.quiz', name: 'A', questions: [shared] },
    { path: 'B.quiz', name: 'B', questions: [structuredClone(shared)] },
  ];
  const pool = buildPool(banks);
  const changed = writeBack(pool, [answered(shared)], banks);
  assert.deepEqual(changed.map((b) => b.path), ['A.quiz']);
});

test('returnedBanksFollowTheOrderOfTheInput', () => {
  const banks = twoBanks();
  const pool = buildPool(banks);
  const changed = writeBack(pool, [answered(banks[1].questions[0]), answered(banks[0].questions[0])], banks);
  assert.deepEqual(changed.map((b) => b.path), ['A.quiz', 'B.quiz']);
});
