// Ported from QVault/Tests/QVaultAppTests/StudyModelTests.swift (51 tests). Names match the
// Swift ones, camelCase as written. The Swift tests save to a temp `.quiz` file; here
// `persist` round-trips the set through the `.quiz` JSON into an in-memory "disk", and the
// tests read what landed there. Tests about keyboard focus and keyboard shortcuts are left
// out (the phone has neither); see .superpowers/sdd/task-4-report.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudyModel } from '../app/engine/studyModel.js';
import { encodeSet, decodeSet } from '../app/engine/quiz.js';
import { decodeState } from '../app/engine/sessionEngine.js';
import { summary } from '../app/engine/stats.js';

/// Repeatable randomness (SplitMix32).
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

const at = (seconds) => new Date(seconds * 1000);

/// A question as decodeSet would produce it: every defaulted field present.
function question(fields) {
  return {
    options: [], keywords: [], tags: [], flagged: false, stats: { attempts: [] }, ...fields,
  };
}

function quizSet(name, questions) {
  return { schema: 1, name, created: at(0), modified: at(0), questions };
}

const mcq = (id, prompt, texts = ['a', 'b'], answer = 'A') => question({
  id, type: 'mcq', prompt, answer,
  options: texts.map((text, i) => ({ letter: String.fromCharCode(65 + i), text })),
});

const open = (id, prompt, answerText = 'a', keywords = []) => question({
  id, type: 'open', prompt, answerText, keywords,
});

/// Swift `fixture(_:)`: q1…qn, two-option MCQs answered "A".
const fixture = (n) => quizSet('T', Array.from({ length: n }, (_, i) => mcq(`q${i + 1}`, `Q${i + 1}`)));

/// Stands in for the `.quiz` file: what `persist` writes, read back as the Mac would load it.
function disk() {
  const d = { saved: null, saves: 0, removed: [], failSave: false, failRemove: false };
  d.persist = (set) => {
    if (d.failSave) throw new Error('The disk is full');
    d.saves += 1;
    d.saved = decodeSet(JSON.stringify(encodeSet(set)));
  };
  d.remove = (id) => {
    if (d.failRemove) throw new Error('The backup failed');
    d.removed.push(id);
  };
  d.question = (id) => d.saved.questions.find((q) => q.id === id);
  return d;
}

/// Written order: these tests press letters and mean the file's letters.
const writtenSettings = { order: 'original', delay: { questions: 2 }, retireThreshold: 2, shuffleOptions: false };

/// Swift `model(_:at:)`: fixture(n), fixed clock.
function model(n, d = disk()) {
  return createStudyModel({
    set: fixture(n), settings: writtenSettings, now: () => at(1_000),
    persist: d.persist, remove: d.remove,
  });
}

/// Swift `makeChoiceModel()`: two two-option MCQs, written order, fixed clock.
const makeChoiceModel = (d = disk()) => model(2, d);

/// Swift `makeOpenModel()`: two open questions, original order, fixed clock.
function makeOpenModel(d = disk()) {
  const set = quizSet('T', [
    open('q1', 'What are microorganisms?', 'Bacteria, archaea, and fungi.', ['bacteria', 'archaea', 'fungi']),
    open('q2', 'What is mitosis?', 'Cell division producing two identical daughter cells.', ['division', 'daughter', 'cells']),
  ]);
  return createStudyModel({
    set, settings: { order: 'original' }, now: () => at(1_000),
    random: splitMix(1), persist: d.persist, remove: d.remove,
  });
}

/// Swift `pausableModel(_:)`: two MCQs, a clock the test drives by hand.
function pausableModel(clock, d = disk()) {
  return createStudyModel({
    set: { ...fixture(2), name: 'Pausable' },
    settings: { order: 'original', retireThreshold: 2 },
    now: clock, random: splitMix(2), persist: d.persist, remove: d.remove,
  });
}

/// Swift `shuffledModel(at:counter:shuffle:)`: one four-option question written with the
/// right answer first, shown reversed; a second question after it.
function shuffledModel({ d = disk(), counter = null, shuffle = true } = {}) {
  const set = quizSet('S', [
    mcq('q', 'Pick the right one', ['right', 'w1', 'w2', 'w3']),
    mcq('q2', 'Another', ['x', 'y']),
  ]);
  return createStudyModel({
    set, settings: { order: 'original', shuffleOptions: shuffle }, now: () => at(1_000),
    persist: d.persist, remove: d.remove,
    orderOptions: (q) => {
      if (counter) counter.count += 1;
      return q.options.map((_, i) => i).reverse();
    },
  });
}

const texts = (q) => q.options.map((o) => o.text);

// MARK: - Answering

test('choosingTheRightLetterRecordsCorrect', () => {
  const m = model(3);
  m.choose('A');
  assert.equal(m.chosen, 'A');
  assert.equal(m.revealed, true); // choosing reveals the answer
  assert.equal(m.lastOutcome, 'correct');
});

test('choosingTheWrongLetterRecordsWrongWithTheChoice', () => {
  const d = disk();
  const m = model(3, d);
  m.choose('B');
  assert.equal(m.lastOutcome, 'wrong');
  // The chosen distractor must reach the record — it is what powers the breakdown.
  assert.equal(d.question('q1').stats.attempts.at(-1).chose, 'B');
});

test('everyAnswerIsPersistedImmediately', () => {
  const d = disk();
  const m = model(3, d);
  m.choose('A');
  // Closing the lid here must cost nothing.
  assert.equal(summary(d.question('q1')).seen, 1);
  assert.notEqual(d.saved.session, undefined);
  assert.notEqual(d.saved.session, null);
});

test('aFinishedSessionClearsItselfFromTheFile', () => {
  const d = disk();
  const m = model(1, d);
  m.choose('A');
  m.advance();
  assert.equal(m.isFinished(), true);
  assert.equal(d.saved.session ?? null, null);
});

test('repeatLaterIsOfferedOnlyAfterACorrectAnswer', () => {
  const m = model(3);
  assert.equal(m.canRepeatLater, false); // nothing answered yet
  m.choose('B');
  assert.equal(m.canRepeatLater, false); // wrong answers are already coming back
  m.advance();
  m.choose('A');
  assert.equal(m.canRepeatLater, true);
});

test('repeatLaterRewritesTheAnswerAsShaky', () => {
  const d = disk();
  const m = model(3, d);
  m.choose('A');
  m.repeatLater();
  const { attempts } = d.question('q1').stats;
  // Exactly one attempt, recorded as shaky — not a correct one plus a shaky one.
  assert.equal(attempts.length, 1);
  assert.equal(attempts.at(-1).outcome, 'shaky');
});

test('undoRemovesTheAttemptAndReturnsToTheQuestion', () => {
  const d = disk();
  const m = model(3, d);
  m.choose('B');
  m.advance();
  assert.equal(m.current?.id, 'q2');

  m.undo();

  assert.equal(m.current?.id, 'q1');
  assert.deepEqual(d.question('q1').stats.attempts, []);
  assert.equal(m.revealed, false);
  assert.equal(m.chosen, null);
});

test('skipRecordsNothing', () => {
  const d = disk();
  const m = model(3, d);
  m.skip();
  assert.ok(d.saved.questions.every((q) => q.stats.attempts.length === 0));
  assert.equal(m.current?.id, 'q2');
});

test('flaggingPersists', () => {
  const d = disk();
  const m = model(3, d);
  m.flagCurrent();
  assert.equal(d.question('q1').flagged, true);
});

test('theCachedCurrentQuestionsSeenCountLagsTheLiveOneByExactlyOne', () => {
  // `current` is the snapshot taken when the question came up, so right after an answer
  // its attempt count is one short of what was just recorded. The view adds 1 back.
  const d = disk();
  const m = model(3, d);
  m.choose('B'); // wrong; requeues rather than retiring, so q1 stays `current`

  const cachedSeen = summary(m.current).seen;
  const liveSeen = d.question(m.current.id).stats.attempts.length;
  assert.equal(liveSeen, cachedSeen + 1);
});

test('flaggingAfterAnsweringLandsOnTheQuestionThatWasOnScreen', () => {
  const d = disk();
  const m = model(3, d);
  // A correct first-time answer retires q1 at once, so the engine is already on q2 —
  // but the reveal is still showing q1.
  m.choose('A');
  assert.equal(m.current?.id, 'q1');

  m.flagCurrent();

  assert.equal(d.question('q1').flagged, true);
  assert.equal(d.question('q2').flagged, false);
  // The snapshot the view reads must show the flag too, not just the file.
  assert.equal(m.current?.flagged, true);
});

// MARK: - Open questions

test('revealWorksAfterFocusEvenWithNothingTyped', () => {
  // The phone has no focus step: reveal works with nothing typed.
  const m = makeOpenModel();
  assert.equal(m.typedAnswer, '');
  m.reveal();
  assert.equal(m.revealed, true);
});

test('theFocusRequirementResetsOnQuestionTransition', () => {
  // Phone version: everything the reveal set up belongs to the question it was for.
  const m = makeOpenModel();
  m.typedAnswer = 'bacteria';
  m.reveal();
  assert.equal(m.hits.length, 3);
  m.grade('wrong'); // `wrong` advances immediately
  assert.equal(m.current?.id, 'q2');
  assert.equal(m.revealed, false);
  assert.equal(m.typedAnswer, '');
  assert.deepEqual(m.hits, []);
  assert.equal(m.recordedMs, null);
});

test('gettingAnOpenQuestionRightHoldsForRepeatLater', () => {
  const d = disk();
  const m = makeOpenModel(d);
  m.reveal();
  m.grade('correct');
  // The user only learns a correct answer was a guess at the moment they give it, so
  // Got it must not have advanced past the chance to say so.
  assert.equal(m.canRepeatLater, true);
  m.repeatLater();
  assert.equal(d.saved.questions[0].stats.attempts.length, 1);
  assert.equal(d.saved.questions[0].stats.attempts.at(-1).outcome, 'shaky');
});

test('gettingAnOpenQuestionWrongAdvancesImmediately', () => {
  const m = makeOpenModel();
  m.reveal();
  m.grade('wrong');
  assert.equal(m.revealed, false);
  assert.equal(m.canRepeatLater, false);
});

test('dontKnowRevealsWithoutAdvancingAndRecordsNoChoice', () => {
  const d = disk();
  const m = makeChoiceModel(d);
  const before = m.current?.id;

  m.dontKnow();

  assert.equal(m.revealed, true);
  assert.equal(m.current?.id, before);
  const attempt = d.saved.questions[0].stats.attempts.at(-1);
  assert.equal(attempt.outcome, 'dontknow');
  assert.equal(attempt.chose, undefined);
});

test('aFailedSaveIsSurfacedRatherThanSwallowed', () => {
  const d = disk();
  const m = makeChoiceModel(d);
  d.failSave = true;
  m.choose('A');
  // An hour of study silently unrecorded is the failure this guards against.
  assert.ok(m.saveError instanceof Error);

  // Cleared by the next save that works.
  d.failSave = false;
  m.advance();
  assert.equal(m.saveError, null);
});

test('theTimerMeasuresTheQuestionNotTheSession', () => {
  let clock = at(1_000);
  const m = createStudyModel({
    set: fixture(3), settings: { order: 'original', delay: { questions: 2 }, retireThreshold: 2 },
    now: () => clock, random: splitMix(3), persist: () => {},
  });

  const sessionStart = m.questionStarted;
  assert.equal(m.recordedMs, null);

  // Six seconds on the first question.
  clock = at(1_006);
  m.choose('A');
  assert.equal(m.recordedMs, 6_000);

  // Reading the revealed answer must not keep the clock running.
  clock = at(1_040);
  assert.equal(m.recordedMs, 6_000);

  // The next question starts its own clock rather than continuing the session's.
  m.advance();
  assert.equal(m.recordedMs, null);
  assert.equal(m.questionStarted.getTime(), at(1_040).getTime());
  assert.ok(m.questionStarted > sessionStart);
});

test('theOpenQuestionTimerFreezesAtRevealNotAtGrade', () => {
  const d = disk();
  let clock = at(1_000);
  const m = createStudyModel({
    set: quizSet('T', [open('q1', 'What are microorganisms?', 'Bacteria, archaea, and fungi.', ['bacteria', 'archaea', 'fungi'])]),
    settings: { order: 'original' }, now: () => clock, persist: d.persist,
  });

  // The answer is submitted (revealed) six seconds in.
  clock = at(1_006);
  m.reveal();
  assert.equal(m.recordedMs, 6_000); // the header freezes immediately at reveal

  // The user reads the revealed answer for 34 more seconds before self-grading.
  clock = at(1_040);
  m.grade('correct');

  // Reading time must not inflate the recorded duration.
  assert.equal(m.recordedMs, 6_000);
  assert.equal(d.saved.questions[0].stats.attempts.at(-1).ms, 6_000);
});

test('keywordMatchingSplitsHitFromMissed', () => {
  const m = createStudyModel({
    set: quizSet('T', [open('q1', 'What are microorganisms?', 'Bacteria, archaea, and fungi.', ['bacteria', 'archaea', 'fungi'])]),
    settings: { order: 'original' }, now: () => at(1_000), persist: () => {},
  });

  m.typedAnswer = 'bacteria and FUNGI';
  m.reveal();

  assert.deepEqual(m.hits.filter((h) => h.hit).map((h) => h.keyword).sort(), ['bacteria', 'fungi']);
  assert.deepEqual(m.hits.filter((h) => !h.hit).map((h) => h.keyword), ['archaea']);
});

// MARK: - Editing mid-session

test('editingTheQuestionOnScreenSavesItWithoutTouchingTheRecord', () => {
  const d = disk();
  const m = makeChoiceModel(d);

  // Answer once so there is a record an edit could destroy.
  m.choose('B');
  const shown = m.current;
  const edited = { ...m.currentAsWritten, prompt: 'Corrected prompt' };

  m.updateCurrentQuestion(edited);

  assert.equal(m.current?.prompt, 'Corrected prompt');
  // The attempt survives the edit: the id is fixed precisely so that correcting a typo
  // never costs the history of answering it.
  assert.equal(m.current?.stats.attempts.length, 1);
  assert.equal(d.question(shown.id).prompt, 'Corrected prompt');
  assert.equal(d.question(shown.id).stats.attempts.length, 1);
});

test('editingTheQuestionAfterAnAnswerEditsTheOneStillOnScreen', () => {
  // The engine moves on as soon as an answer is recorded, so editing by its notion of
  // "current" would rewrite the next question.
  const d = disk();
  const m = makeChoiceModel(d);

  m.choose('A'); // correct, so q1 retires and the engine moves to q2
  m.updateCurrentQuestion({ ...m.currentAsWritten, prompt: 'Edited' });

  assert.equal(d.question('q1').prompt, 'Edited');
  assert.equal(d.question('q2').prompt, 'Q2');
});

test('editingAFinishedSessionIsHarmless', () => {
  const d = disk();
  const m = makeChoiceModel(d);
  m.choose('A');
  m.advance();
  m.choose('A');
  m.advance();
  assert.equal(m.current, null);
  const saves = d.saves;

  m.updateCurrentQuestion(open('q1', 'Nonsense', 'x'));

  assert.equal(d.saves, saves);
  assert.deepEqual(d.saved.questions.map((q) => q.prompt), ['Q1', 'Q2']);
});

// MARK: - Notes

test('addingANoteSavesItWithoutTouchingAnythingElse', () => {
  const d = disk();
  const m = makeChoiceModel(d);

  m.choose('B');
  m.updateCurrentQuestion({ ...m.currentAsWritten, note: 'Keep confusing this with the other one.' });

  const saved = d.question('q1');
  assert.equal(saved.note, 'Keep confusing this with the other one.');
  // A note is an annotation, not an answer: nothing about the question or the record of
  // answering it changes.
  assert.equal(saved.prompt, 'Q1');
  assert.equal(saved.answer, 'A');
  assert.equal(saved.stats.attempts.length, 1);
});

test('aNoteSurvivesLaterAnswersToTheSameQuestion', () => {
  const d = disk();
  const m = makeChoiceModel(d);

  m.updateCurrentQuestion({ ...m.currentAsWritten, note: 'Mine.' });

  m.choose('B'); // wrong, so q1 comes back around
  m.advance();
  for (let guard = 0; m.current?.id !== 'q1'; guard += 1) {
    assert.ok(guard < 10, 'q1 never came back');
    m.skip();
  }
  m.choose('A');

  assert.equal(d.question('q1').note, 'Mine.');
});

// MARK: - Pausing

test('aPauseIsNotCountedAsTimeSpentOnTheQuestion', () => {
  // Time spent looking at a menu is not time spent thinking about the question.
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  seconds = 5; // five seconds thinking
  m.pause();
  seconds = 305; // five minutes paused
  m.resume();
  seconds = 308; // three more seconds thinking
  m.choose('A');

  assert.equal(m.recordedMs, 8_000);
});

test('theClockReadsFrozenWhilePaused', () => {
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  seconds = 7;
  m.pause();
  assert.equal(m.isPaused, true);
  assert.equal(m.frozenMs, 7_000);

  seconds = 900;
  // Still seven seconds, however long the pause runs on.
  assert.equal(m.frozenMs, 7_000);

  m.resume();
  assert.equal(m.isPaused, false);
  assert.equal(m.frozenMs, null);
});

test('pausingTwiceDoesNotMoveTheMomentItPausedAt', () => {
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  seconds = 4;
  m.pause();
  seconds = 60;
  m.pause();
  m.resume();
  seconds = 61;
  m.choose('A');

  assert.equal(m.recordedMs, 5_000);
});

test('restartingTheTimerPutsTheQuestionBackToZero', () => {
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  seconds = 40;
  m.pause();
  assert.equal(m.canRestartQuestionTimer, true);
  m.restartQuestionTimer();
  assert.equal(m.frozenMs, 0);

  m.resume();
  seconds = 43;
  m.choose('A');

  assert.equal(m.recordedMs, 3_000);
});

test('theTimerCannotBeRestartedOnceTheAnswerIsRecorded', () => {
  // Its time is part of the history by then.
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  seconds = 12;
  m.choose('B');
  assert.equal(m.canRestartQuestionTimer, false);

  m.restartQuestionTimer();
  assert.equal(m.recordedMs, 12_000);
});

test('movingToTheNextQuestionClearsAnyPause', () => {
  // A pause belongs to the question that was on screen, not to the session.
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  seconds = 3;
  m.choose('A');
  m.pause();
  m.advance();

  assert.equal(m.isPaused, false);
  assert.equal(m.frozenMs, null);
});

test('resumingWithoutAPauseIsHarmless', () => {
  let seconds = 0;
  const m = pausableModel(() => at(seconds));

  m.resume();
  seconds = 6;
  m.choose('A');

  assert.equal(m.recordedMs, 6_000);
});

// MARK: - Deleting a question mid-session

const openSet = (n) => quizSet('T', Array.from({ length: n }, (_, i) => open(`q${i + 1}`, `Q${i + 1}`)));

test('deletingTheCurrentQuestionRemovesItFromTheFileAndMovesOn', () => {
  const d = disk();
  const m = createStudyModel({
    set: openSet(3), settings: { order: 'original' }, persist: d.persist, remove: d.remove,
  });

  assert.equal(m.current?.id, 'q1');
  m.deleteCurrentQuestion();

  assert.equal(m.current?.id, 'q2');
  // The store is told (and backs up) while there is still something to copy.
  assert.deepEqual(d.removed, ['q1']);
  assert.deepEqual(d.saved.questions.map((q) => q.id), ['q2', 'q3']);
});

test('deletingAQuestionTakesItsHistoryWithIt', () => {
  const d = disk();
  const answered = open('q1', 'Q1');
  answered.stats = { attempts: [{ at: at(1), outcome: 'wrong', ms: 100 }] };
  const m = createStudyModel({
    set: quizSet('T', [answered, open('q2', 'Q2')]), settings: { order: 'original' },
    persist: d.persist, remove: d.remove,
  });

  m.deleteCurrentQuestion();

  assert.deepEqual(d.saved.questions.map((q) => q.id), ['q2']);
  assert.ok(d.saved.questions.every((q) => q.stats.attempts.length === 0));
});

test('deletingTheLastQuestionEndsTheSession', () => {
  const d = disk();
  const m = createStudyModel({
    set: openSet(1), settings: { order: 'original' }, persist: d.persist, remove: d.remove,
  });

  m.deleteCurrentQuestion();

  assert.equal(m.current, null);
  assert.equal(m.isFinished(), true);
  assert.deepEqual(d.saved.questions, []);
});

test('aFailedBackupStopsTheDeleteRatherThanLosingTheQuestion', () => {
  const d = disk();
  d.failRemove = true;
  const m = createStudyModel({
    set: openSet(2), settings: { order: 'original' }, persist: d.persist, remove: d.remove,
  });

  m.deleteCurrentQuestion();

  assert.equal(m.current?.id, 'q1');
  assert.ok(m.saveError instanceof Error);
  assert.equal(d.saved, null); // nothing written
});

// MARK: - Answer choices in a fresh order

test('theScreenShowsTheShuffleAndTheEditorGetsTheFile', () => {
  const m = shuffledModel();
  assert.deepEqual(texts(m.current), ['w3', 'w2', 'w1', 'right']);
  assert.equal(m.current.answer, 'D');
  assert.deepEqual(texts(m.currentAsWritten), ['right', 'w1', 'w2', 'w3']);
  assert.equal(m.currentAsWritten.answer, 'A');
  assert.deepEqual(m.displayOrder, [3, 2, 1, 0]);
});

test('choosingTheShownRightAnswerIsCorrectAndRecordsTheWrittenLetter', () => {
  const d = disk();
  const m = shuffledModel({ d });

  m.choose('D'); // "right", shown last
  assert.equal(m.lastOutcome, 'correct');
  assert.equal(m.chosen, 'D');
  assert.equal(m.chosenAsWritten, 'A');
  const attempt = d.question('q').stats.attempts.at(-1);
  assert.equal(attempt.outcome, 'correct');
  assert.equal(attempt.chose, 'A'); // history keeps the file's letters
});

test('aWrongShownChoiceRecordsItsWrittenLetter', () => {
  const d = disk();
  const m = shuffledModel({ d });

  m.choose('A'); // shown first is "w3", written D
  assert.equal(m.lastOutcome, 'wrong');
  assert.equal(d.question('q').stats.attempts.at(-1).chose, 'D');
});

test('savingAnEditDuringAShuffleLeavesTheFileInWrittenOrder', () => {
  // The failure this whole design exists to prevent: saving a note or an edit while the
  // options are shuffled must not write the shuffle into the file.
  const d = disk();
  const m = shuffledModel({ d });

  m.updateCurrentQuestion({ ...m.currentAsWritten, note: 'remember this' });

  const onDisk = d.question('q');
  assert.deepEqual(texts(onDisk), ['right', 'w1', 'w2', 'w3']);
  assert.equal(onDisk.answer, 'A');
  assert.equal(onDisk.note, 'remember this');
  // And the screen keeps its order rather than rearranging under the finger.
  assert.deepEqual(texts(m.current), ['w3', 'w2', 'w1', 'right']);
});

test('theOrderHoldsWhileOnScreenAndIsDrawnAgainForTheNext', () => {
  const counter = { count: 0 };
  const m = shuffledModel({ counter });

  void m.current; void m.current; m.flagCurrent(); void m.current;
  assert.equal(counter.count, 1); // one showing, one order
  m.choose('D'); m.advance();
  assert.equal(counter.count, 2); // next question, fresh order
});

test('turningShuffleOffShowsTheFileOrder', () => {
  const counter = { count: 0 };
  const m = shuffledModel({ counter, shuffle: false });
  assert.deepEqual(texts(m.current), ['right', 'w1', 'w2', 'w3']);
  assert.equal(counter.count, 0);
});

test('repeatLaterRecordsTheWrittenLetter', () => {
  const d = disk();
  const m = shuffledModel({ d });

  m.choose('D');
  m.repeatLater();
  const attempt = d.question('q').stats.attempts.at(-1);
  assert.equal(attempt.outcome, 'shaky');
  assert.equal(attempt.chose, 'A');
});

// MARK: - Session stopwatch

test('theStopwatchCountsStudyTimeAndNotPauses', () => {
  let clock = at(1_000);
  const m = createStudyModel({
    set: fixture(3), settings: { order: 'original', shuffleOptions: false },
    now: () => clock, persist: () => {},
  });
  const tick = (s) => { clock = new Date(clock.getTime() + s * 1000); };

  tick(10);
  assert.equal(m.activeMs(clock), 10_000);
  m.pause();
  tick(5);
  assert.equal(m.activeMs(clock), 10_000); // holds while paused
  m.resume();
  tick(3);
  assert.equal(m.activeMs(clock), 13_000);
});

test('theStopwatchIsSavedAndCarriesOnWhenTheSessionIsResumed', () => {
  const d = disk();
  let clock = at(1_000);
  const tick = (s) => { clock = new Date(clock.getTime() + s * 1000); };
  const settings = { order: 'original', shuffleOptions: false };
  const first = createStudyModel({
    set: fixture(3), settings, now: () => clock, persist: d.persist,
  });
  tick(42);
  first.choose('A'); // an answer is what writes the file

  const saved = d.saved;
  assert.equal(saved.session.activeMs, 42_000);

  // A new sitting, a day later, picks up at 42 seconds rather than zero.
  tick(86_400);
  const second = createStudyModel({
    set: saved, settings, resume: true, now: () => clock, persist: d.persist,
  });
  tick(8);
  assert.equal(second.activeMs(clock), 50_000);
});

test('aSessionSavedBeforeTheStopwatchExistedResumesAtZero', () => {
  const json = {
    startedAt: '2026-01-01T00:00:00Z', settings: {}, queue: ['q1'], position: 0,
    retired: [], missed: [], streaks: {}, availableAt: {}, answered: 0,
  };
  const state = decodeState(json);
  assert.equal(state.activeMs, 0);

  // And a model resumed from it starts its stopwatch at zero.
  const m = createStudyModel({
    set: { ...fixture(1), session: state }, settings: { order: 'original' }, resume: true,
    now: () => at(1_000), persist: () => {},
  });
  assert.equal(m.activeMs(at(1_000)), 0);
  assert.equal(m.current?.id, 'q1');
});

// MARK: - Phone-only checks of the wrapper rules (no Swift counterpart)

test('optionsAreShuffledWithTheGivenRandomByDefault', () => {
  const set = quizSet('S', [mcq('q', 'Pick', ['right', 'w1', 'w2', 'w3'])]);
  const m = createStudyModel({
    set, settings: { order: 'original', shuffleOptions: true }, random: splitMix(7), persist: () => {},
  });
  assert.notDeepEqual(m.displayOrder, [0, 1, 2, 3]);
  assert.deepEqual([...m.displayOrder].sort(), [0, 1, 2, 3]);
  assert.equal(m.current.options[m.displayOrder.indexOf(0)].text, 'right');
  assert.equal(m.current.answer, m.current.options[m.displayOrder.indexOf(0)].letter);
});

test('anEditThatChangesTheOptionCountDrawsANewOrder', () => {
  const counter = { count: 0 };
  const m = shuffledModel({ counter });

  m.updateCurrentQuestion({ ...m.currentAsWritten, prompt: 'Same four options' });
  assert.equal(counter.count, 1);

  const written = m.currentAsWritten;
  m.updateCurrentQuestion({ ...written, options: written.options.slice(0, 3) });
  assert.equal(counter.count, 2);
  assert.deepEqual(m.displayOrder, [2, 1, 0]);
  assert.deepEqual(texts(m.current), ['w2', 'w1', 'right']);
});

test('persistCarriesTheStopwatchAndTheProgressCounts', () => {
  const d = disk();
  let clock = at(1_000);
  const m = createStudyModel({
    set: fixture(3), settings: writtenSettings, now: () => clock, persist: d.persist,
  });
  assert.deepEqual(m.progress(), { cleared: 0, repeating: 0, total: 3 });
  assert.equal(m.setName, 'T');
  assert.equal(m.canUndo, false);

  clock = at(1_004);
  m.choose('B'); // wrong: q1 comes back
  assert.deepEqual(m.progress(), { cleared: 0, repeating: 1, total: 3 });
  assert.equal(m.canUndo, true);
  m.advance();
  clock = at(1_009);
  m.choose('A'); // q2 cleared
  assert.deepEqual(m.progress(), { cleared: 1, repeating: 1, total: 3 });
  assert.equal(d.saved.session.activeMs, 9_000);
});

test('theQuestionClockRunsUntilPausedAndRestartsForEachQuestion', () => {
  let seconds = 0;
  const m = pausableModel(() => at(seconds));
  assert.equal(m.questionElapsedMs(at(4)), 4_000);
  seconds = 5;
  m.pause();
  assert.equal(m.questionElapsedMs(at(60)), 5_000); // holds while paused
  seconds = 65;
  m.resume();
  assert.equal(m.questionElapsedMs(at(67)), 7_000);
  m.skip();
  assert.equal(m.questionElapsedMs(at(66)), 1_000);
});
