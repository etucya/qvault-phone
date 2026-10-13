// The study screen's keyboard (app/ui/studyKeys.js): which key does what, in which
// state. Ports the intent of the Mac's StudyKeyboardTests.swift: no key moves past an
// unanswered question except skip, the correct option's key moves on once revealed, a
// wrong one does nothing, numbers follow the shown order, Return and the arrows wait for
// the right moment, and the answer box keeps its keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyAction } from '../app/ui/studyKeys.js';

const press = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...mods });

const choice = (over = {}) => ({
  type: 'mcq', revealed: false, graded: false, answerLetter: 'C', optionLetters: ['A', 'B', 'C', 'D'],
  hasImage: false, typingAnswer: false, pictureOpen: false, paused: false, canUndo: false, canRepeatLater: false,
  ...over,
});
const answered = (over = {}) => choice({ revealed: true, graded: true, ...over });
const open = (over = {}) => ({
  type: 'open', revealed: false, graded: false, answerLetter: null, optionLetters: [],
  hasImage: false, typingAnswer: false, pictureOpen: false, paused: false, canUndo: false, canRepeatLater: false,
  ...over,
});

test('letters pick an option before the reveal, in either case', () => {
  assert.equal(keyAction(press('a'), choice()), 'choose:A');
  assert.equal(keyAction(press('D'), choice()), 'choose:D');
  assert.equal(keyAction(press('c'), choice()), 'choose:C');
});

test('numbers pick the nth option in shown order', () => {
  const shown = choice({ optionLetters: ['A', 'B', 'C', 'D'] });
  assert.equal(keyAction(press('1'), shown), 'choose:A');
  assert.equal(keyAction(press('3'), shown), 'choose:C');
  assert.equal(keyAction(press('4'), shown), 'choose:D');
});

test('a letter or number beyond the options is ignored, never clamped', () => {
  assert.equal(keyAction(press('e'), choice()), null);
  assert.equal(keyAction(press('z'), choice()), null);
  assert.equal(keyAction(press('5'), choice()), null);
  assert.equal(keyAction(press('9'), choice()), null);
  assert.equal(keyAction(press('0'), choice()), null);
});

test('a true/false question takes letters and numbers too', () => {
  const tf = choice({ type: 'tf', optionLetters: ['A', 'B'], answerLetter: 'B' });
  assert.equal(keyAction(press('2'), tf), 'choose:B');
  assert.equal(keyAction(press('a'), tf), 'choose:A');
  assert.equal(keyAction(press('3'), tf), null);
});

test('once revealed, the correct option key moves on, by letter or number', () => {
  assert.equal(keyAction(press('c'), answered()), 'advance');
  assert.equal(keyAction(press('3'), answered()), 'advance');
});

test('once revealed, every other option key does nothing', () => {
  for (const key of ['a', 'b', 'd', '1', '2', '4', 'e', '9']) {
    assert.equal(keyAction(press(key), answered()), null, key);
  }
});

test('Return (and Space) does nothing until a choice question is answered, then moves on', () => {
  for (const key of ['Enter', ' ']) {
    assert.equal(keyAction(press(key), choice()), null, key);
    assert.equal(keyAction(press(key), answered()), 'advance', key);
    // After I don't know: revealed, so Return moves on.
    assert.equal(keyAction(press(key), choice({ revealed: true, graded: true })), 'advance', key);
  }
});

test('Return on an open question reveals, waits for the grade, then moves on', () => {
  for (const key of ['Enter', ' ']) {
    assert.equal(keyAction(press(key), open()), 'reveal', key);
    assert.equal(keyAction(press(key), open({ revealed: true })), null, key);
    assert.equal(keyAction(press(key), open({ revealed: true, graded: true })), 'advance', key);
  }
});

test('the arrows grade an open question only between the reveal and the grade', () => {
  assert.equal(keyAction(press('ArrowRight'), open()), null);
  assert.equal(keyAction(press('ArrowLeft'), open()), null);
  assert.equal(keyAction(press('ArrowRight'), open({ revealed: true })), 'gradeCorrect');
  assert.equal(keyAction(press('ArrowLeft'), open({ revealed: true })), 'gradeWrong');
  // Holding for Repeat later after Got it: → is Next (as the Mac), ← does nothing.
  assert.equal(keyAction(press('ArrowRight'), open({ revealed: true, graded: true })), 'advance');
  assert.equal(keyAction(press('ArrowLeft'), open({ revealed: true, graded: true })), null);
});

test('the arrows never touch a choice question', () => {
  for (const state of [choice(), answered()]) {
    assert.equal(keyAction(press('ArrowRight'), state), null);
    assert.equal(keyAction(press('ArrowLeft'), state), null);
  }
});

test('no plain key moves past an unanswered question; only ⌘→ skips', () => {
  const keys = ['Enter', ' ', 'ArrowRight', 'ArrowLeft', 'r', 'm', 'f', 'k', 's', 'x', 'v', 'l', '9'];
  // Scrolling and revealing leave the question where it is.
  const stays = (a) => a === null || a === 'reveal' || a === 'scrollUp' || a === 'scrollDown';
  for (const key of keys) {
    const onChoice = keyAction(press(key), choice({ optionLetters: ['A', 'B'] }));
    assert.ok(onChoice === null || onChoice.startsWith('scroll'), `${key} on a choice question gave ${onChoice}`);
    const onOpen = keyAction(press(key), open());
    assert.ok(stays(onOpen), `${key} on an open question gave ${onOpen}`);
  }
  assert.equal(keyAction(press('ArrowRight', { metaKey: true }), choice()), 'skip');
  assert.equal(keyAction(press('ArrowRight', { ctrlKey: true }), open()), 'skip');
  assert.equal(keyAction(press('ArrowRight', { metaKey: true }), answered()), 'skip');
});

test('⌘D (or Ctrl+D) is I don\'t know before the reveal', () => {
  assert.equal(keyAction(press('d', { metaKey: true }), choice()), 'dontKnow');
  assert.equal(keyAction(press('d', { ctrlKey: true }), choice()), 'dontKnow');
  assert.equal(keyAction(press('d', { metaKey: true }), answered()), null);
  assert.equal(keyAction(press('d', { metaKey: true }), open()), 'dontKnow');
  // A revealed open question: it is the "I don't know" grade, until graded.
  assert.equal(keyAction(press('d', { metaKey: true }), open({ revealed: true })), 'dontKnow');
  assert.equal(keyAction(press('d', { metaKey: true }), open({ revealed: true, graded: true })), null);
  // Plain D is still option D.
  assert.equal(keyAction(press('d'), choice()), 'choose:D');
});

test('the clicker letters do what Karabiner makes them do on the Mac', () => {
  // L2 sends L: undo, when there is something to undo.
  assert.equal(keyAction(press('l'), answered({ canUndo: true })), 'undo');
  assert.equal(keyAction(press('l'), choice({ canUndo: false })), null);
  // ↑ sends V and ↓ sends X: Missed it and Got it on a revealed open question.
  assert.equal(keyAction(press('v'), open({ revealed: true })), 'gradeWrong');
  assert.equal(keyAction(press('x'), open({ revealed: true })), 'gradeCorrect');
  assert.equal(keyAction(press('x'), open({ revealed: true, graded: true })), 'advance');
  assert.equal(keyAction(press('v'), open({ revealed: true, graded: true })), null);
  assert.equal(keyAction(press('v'), choice()), null);
  assert.equal(keyAction(press('x'), choice()), null);
  // R and R2 send M and R: scrolling, never Repeat later and never an option.
  assert.equal(keyAction(press('m'), answered()), 'scrollUp');
  assert.equal(keyAction(press('r'), answered({ canRepeatLater: true })), 'scrollDown');
  // − sends N, which is play/pause on the Mac and never reaches QVault.
  assert.equal(keyAction(press('n'), choice()), null);
  // None of them picks an option of that letter, even on a bank that has one.
  const many = choice({ optionLetters: 'ABCDEFGHIJKLMNOPQRSTUVWX'.split('') });
  for (const key of ['l', 'v', 'x', 'm', 'r', 'n']) assert.notEqual(keyAction(press(key), many), `choose:${key.toUpperCase()}`, key);
  // While typing an answer they all type.
  for (const key of ['l', 'v', 'x', 'm', 'r', 'n']) assert.equal(keyAction(press(key), open({ typingAnswer: true })), null, key);
  // ☰ sends S: the picture, as before; → sends Enter: next.
  assert.equal(keyAction(press('s'), choice({ hasImage: true })), 'togglePicture');
  assert.equal(keyAction(press('Enter'), answered()), 'advance');
});

test('⌘Z (or Ctrl+Z) is undo only when there is something to undo', () => {
  assert.equal(keyAction(press('z', { metaKey: true }), choice({ canUndo: true })), 'undo');
  assert.equal(keyAction(press('z', { ctrlKey: true }), answered({ canUndo: true })), 'undo');
  assert.equal(keyAction(press('z', { metaKey: true }), choice()), null);
});

test('S toggles the picture only when there is one; otherwise it is option S', () => {
  assert.equal(keyAction(press('s'), choice({ hasImage: true })), 'togglePicture');
  assert.equal(keyAction(press('s'), open({ revealed: true, hasImage: true })), 'togglePicture');
  assert.equal(keyAction(press('s'), choice()), null);
  const many = choice({ optionLetters: 'ABCDEFGHIJKLMNOPQRS'.split('') });
  assert.equal(keyAction(press('s'), many), 'choose:S');
  assert.equal(keyAction(press('s'), { ...many, hasImage: true }), 'togglePicture');
});

test('over the picture only S and Esc work', () => {
  const over = choice({ hasImage: true, pictureOpen: true });
  assert.equal(keyAction(press('s'), over), 'togglePicture');
  assert.equal(keyAction(press('Escape'), over), 'escape');
  for (const key of ['a', '1', 'Enter', ' ', 'ArrowRight']) assert.equal(keyAction(press(key), over), null, key);
  assert.equal(keyAction(press('d', { metaKey: true }), over), null);
});

test('over the pause sheet only Esc works', () => {
  const paused = choice({ paused: true, hasImage: true, canUndo: true });
  assert.equal(keyAction(press('Escape'), paused), 'escape');
  for (const key of ['a', '1', 'Enter', ' ', 's', 'r']) assert.equal(keyAction(press(key), paused), null, key);
  assert.equal(keyAction(press('z', { metaKey: true }), paused), null);
  assert.equal(keyAction(press('ArrowRight', { metaKey: true }), paused), null);
});

test('Esc works everywhere there is a question, the answer box included', () => {
  assert.equal(keyAction(press('Escape'), choice()), 'escape');
  assert.equal(keyAction(press('Escape'), answered()), 'escape');
  assert.equal(keyAction(press('Escape'), open({ typingAnswer: true })), 'escape');
});

test('while typing an answer only Return, Esc and ⌘D are taken; everything else types', () => {
  const typing = open({ typingAnswer: true, hasImage: true, canUndo: true, canRepeatLater: true });
  assert.equal(keyAction(press('Enter'), typing), 'reveal');
  assert.equal(keyAction(press('Escape'), typing), 'escape');
  assert.equal(keyAction(press('d', { metaKey: true }), typing), 'dontKnow');
  for (const key of [' ', 'a', 's', 'r', 'f', 'k', '1', 'ArrowRight', 'ArrowLeft', 'Backspace']) {
    assert.equal(keyAction(press(key), typing), null, key);
  }
  // ⌘Z and ⌘→ edit the text.
  assert.equal(keyAction(press('z', { metaKey: true }), typing), null);
  assert.equal(keyAction(press('ArrowRight', { metaKey: true }), typing), null);
  // Shift+Return is a newline.
  assert.equal(keyAction(press('Enter', { shiftKey: true }), typing), null);
});

test('keys with other modifiers are left to the browser', () => {
  assert.equal(keyAction(press('a', { altKey: true }), choice()), null);
  assert.equal(keyAction(press('a', { metaKey: true }), choice()), null);
  assert.equal(keyAction(press('A', { shiftKey: true }), choice()), null);
  assert.equal(keyAction(press('Enter', { shiftKey: true }), answered()), null);
  assert.equal(keyAction(press('Enter', { metaKey: true }), answered()), null);
  assert.equal(keyAction(press('d', { altKey: true, metaKey: true }), choice()), null);
  assert.equal(keyAction(press('d', { metaKey: true, ctrlKey: true }), choice()), null);
  assert.equal(keyAction(press('d', { metaKey: true, shiftKey: true }), choice()), null);
  assert.equal(keyAction(press('ArrowRight', { altKey: true }), open({ revealed: true })), null);
  // ⌘E, ⌘N, ⌘/ and browser shortcuts like ⌘R and ⌘C stay the browser's.
  for (const key of ['e', 'n', '/', 'r', 'c', 'l', 'w']) {
    assert.equal(keyAction(press(key, { metaKey: true }), answered({ canRepeatLater: true })), null, key);
  }
});

test('F, K and other keys with no phone feature are ignored', () => {
  const many = choice({ optionLetters: 'ABCDEFGHIJKL'.split('') });
  assert.equal(keyAction(press('f'), many), null);
  assert.equal(keyAction(press('k'), many), null);
  for (const key of ['Tab', 'Backspace', 'ArrowUp', 'ArrowDown', '-', '/', '?']) {
    assert.equal(keyAction(press(key), choice()), null, key);
  }
});

test('a held key never repeats, and a composing key is never a shortcut', () => {
  assert.equal(keyAction(press('a', { repeat: true }), choice()), null);
  assert.equal(keyAction(press('Enter', { repeat: true }), answered()), null);
  assert.equal(keyAction(press('ArrowRight', { repeat: true }), open({ revealed: true })), null);
  assert.equal(keyAction(press('a', { isComposing: true }), choice()), null);
});

test('with the session finished, no key does anything', () => {
  for (const key of ['Enter', ' ', 'Escape', 'a', '1']) assert.equal(keyAction(press(key), { type: null }), null, key);
  assert.equal(keyAction(press('ArrowRight', { metaKey: true }), { type: null }), null);
  assert.equal(keyAction(null, choice()), null);
  assert.equal(keyAction(press('a'), null), null);
});
