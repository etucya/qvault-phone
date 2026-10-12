// The study screen's rules that need no DOM: clock text, the header's question number,
// the progress track's segments, the feedback and keyword lines, which buttons show in
// each state, what a tap on an option does, and where the screen scrolls. Wording follows
// the Mac (QVaultApp/Session/StudyView.swift, ChoiceQuestionView.swift,
// OpenQuestionView.swift, PauseSheet.swift).

const pad2 = (n) => String(n).padStart(2, '0');
const wholeSeconds = (ms) => Math.max(0, Math.floor((Number(ms) || 0) / 1000));

/** The question clock: minutes and seconds, minutes uncapped ("0:07", "12:30", "75:00"). */
export function formatClock(ms) {
  const total = wholeSeconds(ms);
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/** The session stopwatch: m:ss, growing hours once there are any (h:mm:ss). */
export function formatStopwatch(ms) {
  const total = wholeSeconds(ms);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
}

/**
 * "Question N of M" reads as how far through clearing the set this session has got: the
 * one on screen is the next after the cleared ones, capped so a cleared set never reads
 * past its total.
 */
export function headerIndex({ cleared, total }) {
  return Math.min(cleared + 1, Math.max(total, 1));
}

export function headerText(progress) {
  return `Question ${headerIndex(progress)} of ${progress.total}`;
}

/** "3 repeating", or null when nothing is waiting to come back. */
export function repeatingText({ repeating }) {
  return repeating > 0 ? `${repeating} repeating` : null;
}

const clamp01 = (value) => Math.min(Math.max(value, 0), 1);

/** The split progress track: cleared and repeating as fractions of the whole set. */
export function trackFractions({ cleared, repeating, total }) {
  if (!(total > 0)) return { cleared: 0, repeating: 0 };
  const done = clamp01(cleared / total);
  return { cleared: done, repeating: Math.min(clamp01(repeating / total), 1 - done) };
}

/** What the question clock shows: the recorded (or paused) time once frozen, else running. */
export function questionClockMs(model, now) {
  return model.frozenMs ?? model.questionElapsedMs(now);
}

export function pauseLine(progress, clockMs) {
  return `${headerText(progress)} · ${formatClock(clockMs)} on this question`;
}

// ---------------------------------------------------------------------------------------
// Feedback

const HEADLINES = {
  correct: 'Correct.',
  shaky: "Correct — repeating later since you weren't sure.",
  wrong: 'Incorrect.',
  dontknow: "You didn't know this one.",
};

const TONES = { correct: 'good', shaky: 'warn', wrong: 'bad', dontknow: 'warn' };

/** The choice feedback panel's headline and colour for an outcome. */
export function feedback(outcome) {
  return { text: HEADLINES[outcome] ?? '', tone: TONES[outcome] ?? 'warn' };
}

/**
 * The Mac's misconception line: after a wrong pick made at least twice before on this
 * question. `distractorCount` and `seenCount` are worked out as the Mac does — from the
 * question as it was shown (before this answer), with one added to seen for this answer.
 */
export function distractorNote({ outcome, letter, distractorCount, seenCount }) {
  if (outcome !== 'wrong' || !letter || distractorCount < 2) return null;
  return `You've picked ${letter} on this question ${distractorCount} of the ${seenCount} times you've seen it — that's one specific misconception, not a guess.`;
}

/** `[{keyword, hit}]` → the keyword panel's lines. Always the count; Missed only if any. */
export function keywordLines(hits) {
  const hit = hits.filter((h) => h.hit).map((h) => h.keyword);
  const missed = hits.filter((h) => !h.hit).map((h) => h.keyword);
  return {
    count: `You hit ${hit.length} of ${hits.length} key terms.`,
    missed: missed.length > 0 ? `Missed: ${missed.join(', ')}` : null,
  };
}

export function hitKeywords(hits) {
  return hits.filter((h) => h.hit).map((h) => h.keyword);
}

// ---------------------------------------------------------------------------------------
// Buttons

export const ACTION_LABELS = {
  undo: 'Undo',
  dontKnow: "I don't know",
  reveal: 'Reveal',
  missedIt: 'Missed it',
  gotIt: 'Got it',
  repeatLater: 'Repeat later',
  next: 'Next',
};

/**
 * The action row, left to right (the primary last, under the thumb).
 * `{type, revealed, lastOutcome, canRepeatLater, canUndo}` → action ids.
 */
export function studyActions({ type, revealed, lastOutcome = null, canRepeatLater = false, canUndo = false }) {
  const undo = canUndo ? ['undo'] : [];
  const afterAnswer = [...undo, ...(canRepeatLater ? ['repeatLater'] : []), 'next'];
  if (type === 'open') {
    if (!revealed) return [...undo, 'reveal'];
    if (lastOutcome === null) return ['dontKnow', 'missedIt', 'gotIt'];
    return afterAnswer;
  }
  if (!revealed) return [...undo, 'dontKnow'];
  return afterAnswer;
}

/** How an option row looks: 'correct' and 'wrong' only once revealed, as the Mac's OptionRow. */
export function optionState({ letter, answer, chosen, revealed }) {
  if (!revealed) return 'idle';
  if (letter === answer) return 'correct';
  if (letter === chosen) return 'wrong';
  return 'idle';
}

/**
 * What tapping an option does. Before the reveal it answers; after it, only the correct
 * option responds, and it moves on (the Mac's rule for its option keys), so a reflex tap
 * on a wrong one cannot skip the answer unread.
 */
export function optionTap({ letter, answer, revealed }) {
  if (!revealed) return 'choose';
  return letter === answer ? 'advance' : null;
}

// ---------------------------------------------------------------------------------------
// Scrolling

/**
 * Where the scroll container goes after a redraw, from what was on screen before to what
 * is now (`{id, revealed}` or null): the top for a new showing, the bottom when an answer
 * has just been revealed (so the explanation is in view), otherwise wherever it was.
 */
export function scrollIntent(previous, next) {
  if (!next) return 'top';
  if (!previous || previous.id !== next.id) return 'top';
  if (!previous.revealed && next.revealed) return 'bottom';
  if (previous.revealed && !next.revealed) return 'top';
  return 'keep';
}

// ---------------------------------------------------------------------------------------
// Finished

export function finishedLines({ cleared, total }, activeMs) {
  return {
    counts: `${cleared} of ${total} cleared`,
    time: `${formatStopwatch(activeMs)} studying`,
  };
}

// ---------------------------------------------------------------------------------------
// Questions that are no longer there

/**
 * Moves the model past queued ids whose question is no longer in the set (a sync took it
 * away), so the screen does not show Done with questions still to go. Skips at most once
 * per queued question, so a queue that is dead all the way through cannot loop: it stops
 * with nothing current, and the screen shows Done. Returns how many were skipped.
 */
export function skipDeadQuestions(model) {
  if (model.current || model.isFinished()) return 0;
  const { cleared, total } = model.progress();
  const queued = Math.max(0, total - cleared);
  let skipped = 0;
  while (skipped < queued && !model.current && !model.isFinished()) {
    model.skip();
    skipped += 1;
  }
  return skipped;
}
