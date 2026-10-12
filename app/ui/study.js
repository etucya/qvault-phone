// The study screen: header with the question number, the repeating count, the session
// stopwatch and the question clock over the split progress track; the picture above the
// prompt; option rows or the answer box; after the reveal the feedback, the expected
// answer with its key terms, the explanation and the note; the action row. Pause opens a
// sheet (Resume, Skip this question, Exit to library). A port of the Mac's StudyView,
// ChoiceQuestionView, OpenQuestionView and PauseSheet. The rules live in studyLogic.js;
// every answer, grade and move goes through the study model, which saves after each one.
//
// The screen is redrawn after every model call. Typing in the answer box is not a redraw:
// it only writes `model.typedAnswer`, and a redraw asked for from outside while the box
// has the keyboard only patches the banners. The clocks tick in place, once a second, from
// one interval that stops when the screen is left.

import { el, pillButton, banner } from './components.js';
import { highlightSegments } from '../engine/keywords.js';
import { summary } from '../engine/stats.js';
import { pictureView, pictureOverlay, pictureURL, releasePictures } from './picture.js';
import {
  formatClock, formatStopwatch, headerText, repeatingText, trackFractions, questionClockMs,
  pauseLine, feedback, distractorNote, keywordLines, hitKeywords, studyActions, ACTION_LABELS,
  optionState, optionTap, scrollIntent, finishedLines, skipDeadQuestions,
} from './studyLogic.js';

const SVG = 'http://www.w3.org/2000/svg';

// One study screen at a time, so its bits of screen state live here.
let ctx = null; // {root, store, drive, state, actions}
let ticker = null;
let clocks = null; // {stopwatch, question} text nodes the ticker writes
let shown = null; // {id, revealed} as last drawn, for scrolling
let enlarged = null; // the picture name shown full screen
let pauseShown = false; // the pause sheet has already slid in
let exiting = false;

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------------------------------------------------------------------------------------
// Entry points

/** Draws the study screen for `state.session` into `root`. */
export function renderStudy(root, { store, drive, state, actions }) {
  if (ctx?.state.session !== state.session) {
    // A different session: nothing carried over from the last one.
    shown = null;
    enlarged = null;
    pauseShown = false;
    exiting = false;
    releasePictures();
  }
  const sameSession = ctx?.state.session === state.session;
  ctx = { root, store, drive, state, actions };
  // A redraw from outside (a sync finishing, a banner) while the answer box is being
  // typed in would rebuild the box under the keyboard. Nothing it changes is in the
  // question area, so only the banners are brought up to date; the next tap redraws all.
  if (sameSession && answering()) {
    patchBanners();
    return;
  }
  draw();
}

/** The answer box is on screen and has the keyboard. */
function answering() {
  const box = ctx?.root.querySelector('.answer-box');
  return Boolean(box && globalThis.document?.activeElement === box);
}

function bannerArea(state, model) {
  const banners = el('div', 'banners');
  if (state.saveError || model.saveError) {
    const message = state.saveError
      ?? `Your progress isn't being saved on this phone: ${model.saveError?.message || model.saveError}`;
    banners.append(banner({ message, tone: 'warn' }));
  }
  return banners;
}

function patchBanners() {
  const old = ctx.root.querySelector('.study .banners');
  if (!old || !ctx.state.session) return;
  old.replaceWith(bannerArea(ctx.state, ctx.state.session.model));
}

/** Stops the clocks and lets the pictures go. Safe to call when the screen is not up. */
export function stopStudy() {
  stopTicker();
  if (ctx) releasePictures();
  ctx = null;
  shown = null;
  enlarged = null;
  pauseShown = false;
}

// ---------------------------------------------------------------------------------------
// Small pieces

function icon(paths, className = 'icon') {
  const node = document.createElementNS(SVG, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    node.append(path);
  }
  return node;
}

const ICONS = {
  pause: ['M9 5v14', 'M15 5v14'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  cross: ['M7 7l10 10', 'M17 7L7 17'],
  stopwatch: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M12 9v4l2.5 1.5', 'M10 2h4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5'],
  note: ['M5 3h10l4 4v14H5z', 'M9 11h6', 'M9 15h6'],
};

function iconButton(label, glyph, onTap) {
  const button = el('button', 'icon-button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.append(icon(ICONS[glyph]));
  button.addEventListener('click', onTap);
  return button;
}

function noteBlock(text, kind) {
  const block = el('div', `note-block note-${kind}`);
  block.append(icon(ICONS[kind === 'explain' ? 'book' : 'note'], 'icon note-icon'), el('p', 'note-text', text));
  return block;
}

/** The Mac's AnswerNotes: the explanation, then the note, when there are any. */
function answerNotes(question) {
  const notes = [];
  if (question.explanation) notes.push(noteBlock(question.explanation, 'explain'));
  if (question.note) notes.push(noteBlock(question.note, 'note'));
  if (notes.length === 0) return null;
  const wrap = el('div', 'notes');
  wrap.append(...notes);
  return wrap;
}

// The phone backgrounding the app (or locking) may be the last we hear of it: write the
// session, stopwatch included. The pause state is left as it is.
globalThis.document?.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden' || exiting || !ctx?.state.session) return;
  const session = ctx.state.session;
  session.model?.save?.();
  session.flush?.()?.catch?.(() => {});
});

// ---------------------------------------------------------------------------------------
// Acting

/** Runs a model call, then redraws. Nothing happens once the screen is on its way out. */
function act(fn) {
  return () => {
    if (exiting || !ctx?.state.session) return;
    fn(ctx.state.session.model);
    draw();
  };
}

async function exitToLibrary() {
  if (exiting || !ctx) return;
  exiting = true;
  const { state, actions } = ctx;
  const session = state.session;
  stopStudy();
  try {
    // The stopwatch is written even when no answer has been given since the last save.
    session?.model?.save?.();
    await session?.flush?.();
  } catch {
    // A failed write has already been reported through onSaveError.
  }
  // The session is in the store, so the bank offers Resume next time.
  state.session = null;
  state.route = 'library';
  state.banks = null;
  if (state.saveError) {
    state.error = state.saveError;
    state.saveError = null;
  }
  exiting = false;
  actions.render();
}

const ACTION_STYLES = {
  undo: 'ghost',
  dontKnow: 'secondary',
  reveal: 'primary',
  missedIt: 'bad',
  gotIt: 'good',
  repeatLater: 'secondary',
  next: 'primary',
};

function actionRow(model, question) {
  const handlers = {
    undo: act((m) => m.undo()),
    dontKnow: act((m) => (question.type === 'open' ? m.grade('dontknow') : m.dontKnow())),
    reveal: act((m) => {
      ctx.root.querySelector('.answer-box')?.blur(); // the keyboard goes down
      m.reveal();
    }),
    missedIt: act((m) => m.grade('wrong')),
    gotIt: act((m) => m.grade('correct')),
    repeatLater: act((m) => m.repeatLater()),
    next: act((m) => m.advance()),
  };
  const ids = studyActions({
    type: question.type,
    revealed: model.revealed,
    lastOutcome: model.lastOutcome,
    canRepeatLater: model.canRepeatLater,
    canUndo: model.canUndo,
  });
  const row = el('div', 'study-actions');
  if (ids.length === 3 && ids[0] === 'dontKnow') row.classList.add('study-actions-grade');
  for (const id of ids) {
    const button = pillButton({ label: ACTION_LABELS[id], style: ACTION_STYLES[id], onTap: handlers[id] });
    button.classList.add(`action-${id}`);
    row.append(button);
  }
  return row;
}

// ---------------------------------------------------------------------------------------
// Header

function header(model, title, current) {
  const head = el('header', 'study-head');
  const bar = el('div', 'study-bar');
  // Nothing to pause once the session is done; the gap keeps the title centred.
  const pause = current ? iconButton('Pause', 'pause', act((m) => m.pause())) : el('span', 'icon-gap');
  bar.append(pause, el('h1', 'study-title', title), iconButton('Close', 'close', exitToLibrary));
  head.append(bar);
  if (!current) return head;

  const progress = model.progress();
  const meta = el('div', 'study-meta');
  meta.append(el('span', 'study-count', headerText(progress)));
  const repeating = repeatingText(progress);
  if (repeating) meta.append(el('span', 'study-repeating', repeating));
  meta.append(el('span', 'study-spacer'));

  const now = new Date();
  const stopwatch = el('span', 'study-clock study-stopwatch');
  stopwatch.setAttribute('aria-label', 'Time studying this session, not counting pauses');
  const stopwatchText = el('span', 'clock-text', formatStopwatch(model.activeMs(now)));
  stopwatch.append(icon(ICONS.stopwatch, 'icon clock-icon'), stopwatchText);
  const clock = el('span', 'study-clock study-qclock');
  clock.setAttribute('aria-label', 'Time on this question');
  const clockText = el('span', 'clock-text', formatClock(questionClockMs(model, now)));
  clock.append(icon(ICONS.clock, 'icon clock-icon'), clockText);
  meta.append(stopwatch, clock);
  clocks = { stopwatch: stopwatchText, question: clockText };

  const fractions = trackFractions(progress);
  const track = el('div', 'track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(progress.total));
  track.setAttribute('aria-valuenow', String(progress.cleared));
  const cleared = el('div', 'track-cleared');
  cleared.style.width = `${fractions.cleared * 100}%`;
  const waiting = el('div', 'track-repeating');
  waiting.style.width = `${fractions.repeating * 100}%`;
  track.append(cleared, waiting);

  head.append(meta, track);
  return head;
}

function tick() {
  const model = ctx?.state.session?.model;
  if (!model || !clocks) return;
  const now = new Date();
  clocks.stopwatch.textContent = formatStopwatch(model.activeMs(now));
  clocks.question.textContent = formatClock(questionClockMs(model, now));
}

function startTicker() {
  if (ticker === null) ticker = setInterval(tick, 1000);
}

function stopTicker() {
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  clocks = null;
}

// ---------------------------------------------------------------------------------------
// Questions

function choiceBody(model, question) {
  const parts = [];
  const list = el('div', 'options');
  for (const option of question.options) {
    const look = optionState({ letter: option.letter, answer: question.answer, chosen: model.chosen, revealed: model.revealed });
    const tap = optionTap({ letter: option.letter, answer: question.answer, revealed: model.revealed });
    const row = el('button', `option option-${look}`);
    row.type = 'button';
    if (model.revealed && option.letter === model.chosen) row.classList.add('option-chosen');
    row.append(el('span', 'option-letter', option.letter), el('span', 'option-text', option.text));
    if (look === 'correct') row.append(icon(ICONS.check, 'icon option-mark'));
    else if (look === 'wrong') row.append(icon(ICONS.cross, 'icon option-mark'));
    if (tap === 'choose') {
      row.addEventListener('click', act((m) => m.choose(option.letter)));
    } else if (tap === 'advance') {
      row.setAttribute('aria-label', `${option.letter}. ${option.text}. Correct. Tap to go to the next question.`);
      row.addEventListener('click', act((m) => m.advance()));
    } else {
      row.disabled = true;
    }
    list.append(row);
  }
  parts.push(list);

  if (model.revealed && model.lastOutcome) {
    const { text, tone } = feedback(model.lastOutcome);
    const panel = el('div', `panel-tint tint-${tone} feedback`);
    panel.setAttribute('role', 'status');
    panel.append(el('p', 'feedback-text', text));
    // As the Mac works it out: from the question as it was shown, so before this answer.
    const before = summary(model.currentAsWritten ?? question);
    const chosenWritten = model.chosenAsWritten;
    const note = distractorNote({
      outcome: model.lastOutcome,
      letter: model.chosen,
      distractorCount: chosenWritten ? before.distractors[chosenWritten] ?? 0 : 0,
      seenCount: before.seen + 1,
    });
    if (note) panel.append(el('p', 'feedback-text', note));
    parts.push(panel);
  }
  if (model.revealed) {
    const notes = answerNotes(question);
    if (notes) parts.push(notes);
  }
  return parts;
}

function growToFit(box) {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight + 2}px`;
}

function openBody(model, question) {
  const parts = [];
  if (!model.revealed) {
    const box = el('textarea', 'answer-box');
    box.rows = 3;
    box.placeholder = 'Type your answer';
    box.setAttribute('aria-label', 'Your answer');
    box.autocapitalize = 'sentences';
    box.spellcheck = true;
    box.value = model.typedAnswer;
    box.addEventListener('input', () => {
      model.typedAnswer = box.value;
      growToFit(box);
    });
    parts.push(box);
    return parts;
  }

  const typed = model.typedAnswer.trim();
  if (typed === '') {
    parts.push(el('p', 'answer-none', "You didn't answer."));
  } else {
    const yours = el('div', 'panel-tint tint-plain answer-panel');
    yours.append(el('p', 'answer-label', 'Your answer'), el('p', 'answer-text', model.typedAnswer));
    parts.push(yours);
  }

  const expected = el('div', 'panel-tint tint-good answer-panel');
  const text = el('p', 'answer-text');
  for (const segment of highlightSegments(question.answerText ?? '', hitKeywords(model.hits))) {
    text.append(segment.highlighted ? el('span', 'keyword-hit', segment.text) : document.createTextNode(segment.text));
  }
  expected.append(el('p', 'answer-label answer-label-good', 'Expected answer'), text);
  parts.push(expected);

  const lines = keywordLines(model.hits);
  const keywords = el('div', 'panel-tint tint-warn keyword-lines');
  keywords.append(el('p', 'feedback-text', lines.count));
  if (lines.missed) keywords.append(el('p', 'feedback-text', lines.missed));
  parts.push(keywords);

  const notes = answerNotes(question);
  if (notes) parts.push(notes);
  return parts;
}

// ---------------------------------------------------------------------------------------
// Overlays

function pauseChoice(title, detail, tone, onTap) {
  const row = el('button', `pause-choice pause-${tone}`);
  row.type = 'button';
  const words = el('span', 'pause-words');
  words.append(el('span', 'pause-choice-title', title), el('span', 'pause-choice-detail', detail));
  row.append(el('span', 'pause-dot'), words);
  row.addEventListener('click', onTap);
  return row;
}

function pauseSheet(model) {
  const resume = act((m) => m.resume());
  const layer = el('div', pauseShown ? 'sheet-layer pause-layer' : 'sheet-layer pause-layer sheet-enter');
  const scrim = el('div', 'sheet-scrim');
  scrim.setAttribute('aria-hidden', 'true');
  // Tapping round the sheet resumes: a closed pause sheet would only stop the clock unseen.
  scrim.addEventListener('click', resume);
  const sheet = el('div', 'sheet pause-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'pause-title');
  const title = el('h2', 'sheet-title', 'Paused');
  title.id = 'pause-title';
  const now = new Date();
  const head = el('div', 'pause-head');
  head.append(title, el('p', 'sheet-subtitle', pauseLine(model.progress(), questionClockMs(model, now))));
  const choices = el('div', 'pause-choices');
  choices.append(
    pauseChoice('Resume', "Pick up where you left off. The pause isn't counted.", 'good', resume),
    pauseChoice('Skip this question', 'Move on without recording an answer. It stays in the set.', 'cyan', act((m) => {
      // Resumed first, so the pause comes off the stopwatch before the skip saves it.
      m.resume();
      m.skip();
    })),
    pauseChoice('Exit to library', 'Your progress is saved — you can pick this set back up later.', 'dim', exitToLibrary),
  );
  sheet.append(el('div', 'sheet-grabber'), head, choices);
  layer.append(scrim, sheet);
  pauseShown = true;
  return layer;
}

// ---------------------------------------------------------------------------------------
// Drawing

function finishedPanel(model) {
  const centre = el('div', 'centre');
  const panel = el('div', 'panel hero finished');
  const lines = finishedLines(model.progress(), model.activeMs(new Date()));
  panel.append(
    el('h2', 'finished-title', 'Done'),
    el('p', 'hero-text', 'Session complete.'),
    el('p', 'finished-line', lines.counts),
    el('p', 'finished-line', lines.time),
    pillButton({ label: 'Exit', style: 'primary', onTap: exitToLibrary }),
  );
  centre.append(panel);
  return centre;
}

function draw() {
  if (!ctx?.state.session) return;
  const { root, store, drive, state } = ctx;
  const { model, title } = state.session;
  // A queued question a sync took away is moved past rather than read as the end.
  skipDeadQuestions(model);
  const current = model.current;

  // What to carry over from the screen being replaced.
  const oldScroll = root.querySelector('.study-scroll');
  const keepScroll = oldScroll?.scrollTop ?? 0;
  const oldBox = root.querySelector('.answer-box');
  const typing = oldBox && document.activeElement === oldBox
    ? { start: oldBox.selectionStart, end: oldBox.selectionEnd }
    : null;

  const next = current ? { id: current.id, revealed: model.revealed } : null;
  const intent = scrollIntent(shown, next);
  if (!next || shown?.id !== next.id) enlarged = null; // a picture never outlives its question
  shown = next;
  if (!model.isPaused) pauseShown = false;

  stopTicker();
  const screen = el('div', 'screen study');
  screen.append(header(model, title, current));

  screen.append(bannerArea(state, model));

  if (!current) {
    screen.append(finishedPanel(model));
    root.replaceChildren(screen);
    return;
  }

  const scroll = el('div', 'scroll study-scroll');
  const column = el('div', 'study-column');
  if (current.image) {
    column.append(pictureView(current.image, {
      drive,
      store,
      onEnlarge: (name) => {
        if (!pictureURL(name)) return;
        enlarged = name;
        draw();
      },
    }));
  }
  column.append(el('p', 'study-prompt', current.prompt));
  const body = current.type === 'open' ? openBody(model, current) : choiceBody(model, current);
  column.append(...body, actionRow(model, current));
  scroll.append(column);
  screen.append(scroll);

  const layers = [];
  if (model.isPaused) layers.push(pauseSheet(model));
  else if (enlarged && pictureURL(enlarged)) {
    layers.push(pictureOverlay(enlarged, {
      onClose: () => {
        enlarged = null;
        draw();
      },
    }));
  }
  if (layers.length > 0) screen.inert = true;
  root.replaceChildren(screen, ...layers);

  // The answer box keeps its text (from the model) and, if it had it, the cursor.
  const box = scroll.querySelector('.answer-box');
  if (box) {
    growToFit(box);
    if (typing && layers.length === 0) {
      box.focus({ preventScroll: true });
      box.setSelectionRange(typing.start, typing.end);
    }
  }

  if (intent === 'top') {
    scroll.scrollTop = 0;
  } else {
    scroll.scrollTop = keepScroll;
    if (intent === 'bottom') {
      // After the reveal has been laid out, or there is no bottom to go to yet. A short
      // timer rather than an animation frame (the Mac waits 120 ms too): frames are held
      // back while the page is not being painted, and the scroll must still happen.
      setTimeout(() => {
        if (!scroll.isConnected) return;
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
      }, 120);
    }
  }

  startTicker();
}
