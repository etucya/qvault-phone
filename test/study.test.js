// The study screen's pure rules (app/ui/studyLogic.js): clock text, the header's question
// number, the progress track, feedback and keyword lines, which buttons show, what an
// option tap does, and where the screen scrolls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClock, formatStopwatch, headerIndex, headerText, repeatingText, trackFractions,
  questionClockMs, pauseLine, feedback, distractorNote, keywordLines, hitKeywords,
  studyActions, ACTION_LABELS, optionState, optionTap, scrollIntent, finishedLines, skipDeadQuestions,
} from '../app/ui/studyLogic.js';
import { createStudyModel } from '../app/engine/studyModel.js';
import { decodeSettings } from '../app/engine/settings.js';

test('the question clock is m:ss with minutes uncapped', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(999), '0:00');
  assert.equal(formatClock(7000), '0:07');
  assert.equal(formatClock(61_500), '1:01');
  assert.equal(formatClock(75 * 60_000), '75:00');
  assert.equal(formatClock(-5000), '0:00');
  assert.equal(formatClock(null), '0:00');
});

test('the stopwatch is m:ss, then h:mm:ss from an hour', () => {
  assert.equal(formatStopwatch(0), '0:00');
  assert.equal(formatStopwatch(59 * 60_000 + 59_999), '59:59');
  assert.equal(formatStopwatch(3_600_000), '1:00:00');
  assert.equal(formatStopwatch(3_600_000 + 5 * 60_000 + 9000), '1:05:09');
  assert.equal(formatStopwatch(12 * 3_600_000), '12:00:00');
});

test('the header number is cleared + 1, capped at the total (and at least 1)', () => {
  assert.equal(headerIndex({ cleared: 0, total: 10 }), 1);
  assert.equal(headerIndex({ cleared: 4, total: 10 }), 5);
  assert.equal(headerIndex({ cleared: 10, total: 10 }), 10);
  assert.equal(headerIndex({ cleared: 0, total: 0 }), 1);
  assert.equal(headerText({ cleared: 2, repeating: 1, total: 6 }), 'Question 3 of 6');
});

test('the repeating count shows only when something is repeating', () => {
  assert.equal(repeatingText({ repeating: 0 }), null);
  assert.equal(repeatingText({ repeating: 3 }), '3 repeating');
});

test('the progress track splits into cleared and repeating, never past the end', () => {
  assert.deepEqual(trackFractions({ cleared: 0, repeating: 0, total: 0 }), { cleared: 0, repeating: 0 });
  assert.deepEqual(trackFractions({ cleared: 1, repeating: 1, total: 4 }), { cleared: 0.25, repeating: 0.25 });
  const full = trackFractions({ cleared: 3, repeating: 3, total: 4 });
  assert.equal(full.cleared, 0.75);
  assert.equal(full.repeating, 0.25);
});

test('the question clock reads the frozen time when there is one, else the running time', () => {
  const running = { frozenMs: null, questionElapsedMs: () => 4200 };
  const frozen = { frozenMs: 9000, questionElapsedMs: () => 99_999 };
  assert.equal(questionClockMs(running, new Date()), 4200);
  assert.equal(questionClockMs(frozen, new Date()), 9000);
  assert.equal(pauseLine({ cleared: 1, repeating: 0, total: 6 }, 65_000), 'Question 2 of 6 · 1:05 on this question');
});

test('the feedback headline and colour follow the Mac', () => {
  assert.deepEqual(feedback('correct'), { text: 'Correct.', tone: 'good' });
  assert.deepEqual(feedback('shaky'), { text: "Correct — repeating later since you weren't sure.", tone: 'warn' });
  assert.deepEqual(feedback('wrong'), { text: 'Incorrect.', tone: 'bad' });
  assert.deepEqual(feedback('dontknow'), { text: "You didn't know this one.", tone: 'warn' });
});

test('the misconception line needs a wrong pick made at least twice', () => {
  assert.equal(distractorNote({ outcome: 'wrong', letter: 'B', distractorCount: 1, seenCount: 3 }), null);
  assert.equal(distractorNote({ outcome: 'correct', letter: 'B', distractorCount: 4, seenCount: 5 }), null);
  assert.equal(distractorNote({ outcome: 'wrong', letter: null, distractorCount: 4, seenCount: 5 }), null);
  assert.equal(
    distractorNote({ outcome: 'wrong', letter: 'B', distractorCount: 2, seenCount: 4 }),
    "You've picked B on this question 2 of the 4 times you've seen it — that's one specific misconception, not a guess.",
  );
});

test('the key-term lines: always the count, Missed only when something was missed', () => {
  const some = [
    { keyword: 'bacteria', hit: true },
    { keyword: 'fungi', hit: false },
    { keyword: 'algae', hit: false },
  ];
  assert.deepEqual(keywordLines(some), { count: 'You hit 1 of 3 key terms.', missed: 'Missed: fungi, algae' });
  assert.deepEqual(hitKeywords(some), ['bacteria']);
  assert.deepEqual(keywordLines([{ keyword: 'x', hit: true }]), { count: 'You hit 1 of 1 key terms.', missed: null });
  assert.deepEqual(keywordLines([]), { count: 'You hit 0 of 0 key terms.', missed: null });
});

test('choice questions: I don\'t know before the reveal; Repeat later, Undo and Next after', () => {
  assert.deepEqual(studyActions({ type: 'mcq', revealed: false }), ['dontKnow']);
  assert.deepEqual(studyActions({ type: 'mcq', revealed: false, canUndo: true }), ['undo', 'dontKnow']);
  assert.deepEqual(
    studyActions({ type: 'mcq', revealed: true, lastOutcome: 'correct', canRepeatLater: true, canUndo: true }),
    ['undo', 'repeatLater', 'next'],
  );
  assert.deepEqual(studyActions({ type: 'tf', revealed: true, lastOutcome: 'wrong', canUndo: true }), ['undo', 'next']);
  assert.deepEqual(studyActions({ type: 'mcq', revealed: true, lastOutcome: 'shaky' }), ['next']);
});

test('open questions: Reveal, then the three grades, then Next after Got it', () => {
  assert.deepEqual(studyActions({ type: 'open', revealed: false }), ['reveal']);
  assert.deepEqual(studyActions({ type: 'open', revealed: false, canUndo: true }), ['undo', 'reveal']);
  assert.deepEqual(studyActions({ type: 'open', revealed: true, lastOutcome: null, canUndo: true }), ['dontKnow', 'missedIt', 'gotIt']);
  assert.deepEqual(
    studyActions({ type: 'open', revealed: true, lastOutcome: 'correct', canRepeatLater: true, canUndo: true }),
    ['undo', 'repeatLater', 'next'],
  );
  assert.deepEqual(studyActions({ type: 'open', revealed: true, lastOutcome: 'shaky', canUndo: true }), ['undo', 'next']);
});

test('every action has a label', () => {
  assert.equal(ACTION_LABELS.gotIt, 'Got it');
  assert.equal(ACTION_LABELS.missedIt, 'Missed it');
  assert.equal(ACTION_LABELS.dontKnow, "I don't know");
  assert.equal(ACTION_LABELS.repeatLater, 'Repeat later');
  for (const id of ['undo', 'dontKnow', 'reveal', 'missedIt', 'gotIt', 'repeatLater', 'next']) assert.ok(ACTION_LABELS[id]);
});

test('option rows colour the answer good and a wrong pick bad, only once revealed', () => {
  const base = { answer: 'B', chosen: 'C' };
  assert.equal(optionState({ ...base, letter: 'B', revealed: false }), 'idle');
  assert.equal(optionState({ ...base, letter: 'B', revealed: true }), 'correct');
  assert.equal(optionState({ ...base, letter: 'C', revealed: true }), 'wrong');
  assert.equal(optionState({ ...base, letter: 'A', revealed: true }), 'idle');
  assert.equal(optionState({ answer: 'B', chosen: 'B', letter: 'B', revealed: true }), 'correct');
  assert.equal(optionState({ answer: 'B', chosen: null, letter: 'A', revealed: true }), 'idle');
});

test('tapping an option answers; after the reveal only the correct one responds, and it moves on', () => {
  assert.equal(optionTap({ letter: 'A', answer: 'B', revealed: false }), 'choose');
  assert.equal(optionTap({ letter: 'B', answer: 'B', revealed: true }), 'advance');
  assert.equal(optionTap({ letter: 'A', answer: 'B', revealed: true }), null);
});

test('scrolling: top for a new showing, bottom on reveal, otherwise where it was', () => {
  assert.equal(scrollIntent(null, { id: 'a', revealed: false }), 'top');
  assert.equal(scrollIntent({ id: 'a', revealed: true }, { id: 'b', revealed: false }), 'top');
  assert.equal(scrollIntent({ id: 'a', revealed: false }, { id: 'a', revealed: true }), 'bottom');
  assert.equal(scrollIntent({ id: 'a', revealed: true }, { id: 'a', revealed: true }), 'keep');
  assert.equal(scrollIntent({ id: 'a', revealed: false }, { id: 'a', revealed: false }), 'keep');
  // The same question again (undo, or a repeat straight away) starts from the top.
  assert.equal(scrollIntent({ id: 'a', revealed: true }, { id: 'a', revealed: false }), 'top');
  assert.equal(scrollIntent({ id: 'a', revealed: true }, null), 'top');
});

test('the finished panel counts and the session time', () => {
  assert.deepEqual(finishedLines({ cleared: 6, repeating: 0, total: 6 }, 252_000), {
    counts: '6 of 6 cleared',
    time: '4:12 studying',
  });
});

// ---------------------------------------------------------------------------------------
// Dead ids: a queued id whose question is gone

const liveQuestion = (id) => ({
  id, type: 'mcq', prompt: `Prompt ${id}`, answer: 'A', keywords: [], tags: [], flagged: false,
  options: [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }], stats: { attempts: [] },
});

// Resumed with a shuffle that keeps the saved order (random 0.99 never swaps), so a dead id
// stays where it was put rather than being sorted to the end.
function modelOver(questions, queue) {
  const session = {
    startedAt: new Date(0), settings: decodeSettings({ order: 'shuffle' }), queue, position: 0,
    retired: [], missed: [], streaks: {}, availableAt: {}, answered: 0, activeMs: 0,
  };
  return createStudyModel({
    set: { name: 'S', questions, session }, settings: session.settings, resume: true,
    persist: () => {}, remove: () => {}, now: () => new Date(1000), random: () => 0.99,
  });
}

test('a dead id at the front of the queue is skipped to the next live question', () => {
  const model = modelOver([liveQuestion('live')], ['gone', 'live']);
  assert.equal(model.current, null);
  assert.equal(model.isFinished(), false);
  assert.equal(skipDeadQuestions(model), 1);
  assert.equal(model.current.id, 'live');
});

test('a queue that is dead all the way through stops after one pass, with nothing current', () => {
  const model = modelOver([liveQuestion('other')], ['gone1', 'gone2', 'gone3']);
  assert.equal(skipDeadQuestions(model), 3);
  assert.equal(model.current, null);
});

test('nothing is skipped while a question is current or once finished', () => {
  const model = modelOver([liveQuestion('a')], ['a']);
  assert.equal(skipDeadQuestions(model), 0);
  assert.equal(model.current.id, 'a');
  let skips = 0;
  const finished = { current: null, isFinished: () => true, progress: () => ({ cleared: 1, total: 1 }), skip: () => { skips += 1; } };
  assert.equal(skipDeadQuestions(finished), 0);
  assert.equal(skips, 0);
});
