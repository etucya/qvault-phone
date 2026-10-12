import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identity, shuffled, present, writtenLetter, isPinned,
  refersToOtherOptions, isTrueFalsePair,
} from '../app/engine/optionOrder.js';

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

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
function mcq(texts, answer = 'A') {
  return {
    id: 'q', type: 'mcq', prompt: '?',
    options: texts.map((text, i) => ({ letter: LETTERS[i], text })),
    answer,
  };
}
const sorted = (a) => [...a].sort((x, y) => x - y);

test('identity is the written order', () => {
  assert.deepEqual(identity(mcq(['a', 'b', 'c'])), [0, 1, 2]);
  assert.deepEqual(identity(mcq([])), []);
});

test('aShuffleIsAlwaysARearrangementAndNeverTheWrittenOrder', () => {
  const g = splitMix(1);
  const q = mcq(['a', 'b', 'c', 'd']);
  for (let i = 0; i < 300; i++) {
    const order = shuffled(q, g);
    assert.deepEqual(sorted(order), [0, 1, 2, 3]);
    assert.notDeepEqual(order, [0, 1, 2, 3]);
  }
});

test('twoOptionsFlipACoinRatherThanAlwaysSwapping', () => {
  const g = splitMix(2);
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(JSON.stringify(shuffled(mcq(['a', 'b']), g)));
  assert.deepEqual([...seen].sort(), ['[0,1]', '[1,0]']);
});

test('aTrueFalseQuestionTypedAsMultipleChoiceKeepsTrueFirst', () => {
  const g = splitMix(5);
  for (const texts of [['True', 'False'], ['true', 'false'], ['TRUE.', 'FALSE.']]) {
    for (let i = 0; i < 20; i++) assert.deepEqual(shuffled(mcq(texts), g), [0, 1], texts.join());
  }
  // Written the other way round it stays that way too: nothing is reordered.
  for (let i = 0; i < 20; i++) assert.deepEqual(shuffled(mcq(['False', 'True']), g), [0, 1]);
});

test('trueFalseIsNeverShuffled', () => {
  const g = splitMix(3);
  const tf = {
    id: 't', type: 'tf', prompt: '?',
    options: [{ letter: 'A', text: 'True' }, { letter: 'B', text: 'False' }],
    answer: 'A',
  };
  for (let i = 0; i < 20; i++) assert.deepEqual(shuffled(tf, g), [0, 1]);
});

test('allOfTheAboveKeepsItsPlace', () => {
  const g = splitMix(4);
  const q = mcq(['a', 'b', 'c', 'All of the above']);
  for (let i = 0; i < 200; i++) {
    const order = shuffled(q, g);
    assert.equal(order[3], 3);
    assert.notDeepEqual(order, [0, 1, 2, 3]);
  }
});

test('noneOfTheseKeepsItsPlaceWhereverItIsWritten', () => {
  const g = splitMix(5);
  const q = mcq(['None of these', 'a', 'b', 'c']);
  for (let i = 0; i < 200; i++) assert.equal(shuffled(q, g)[0], 0);
  const middle = mcq(['a', 'None of these', 'b', 'c']);
  for (let i = 0; i < 200; i++) assert.equal(shuffled(middle, g)[1], 1);
});

test('optionsThatNameOtherOptionsAreNeverShuffled', () => {
  const g = splitMix(6);
  assert.deepEqual(shuffled(mcq(['a', 'b', 'c', 'Both A and C']), g), [0, 1, 2, 3]);
  assert.deepEqual(shuffled(mcq(['a', 'b', 'c', 'A and B']), g), [0, 1, 2, 3]);
  assert.deepEqual(shuffled(mcq(['a', 'b', 'Only B', 'd']), g), [0, 1, 2, 3]);
});

test('aSingleCapitalLetterInAnOptionIsNotAReference', () => {
  const g = splitMix(7);
  const q = mcq(['Vitamin A', 'Hepatitis B', 'Type II collagen', 'Complex I']);
  assert.equal(refersToOtherOptions(q), false);
  assert.notDeepEqual(shuffled(q, g), [0, 1, 2, 3]);
  // Nor is a lowercase article after a picking word.
  const p = mcq(['Only a small amount', 'b', 'c', 'd']);
  assert.equal(refersToOtherOptions(p), false);
  assert.notDeepEqual(shuffled(p, g), [0, 1, 2, 3]);
});

test('theAnswerMovesWithItsText', () => {
  const q = mcq(['right', 'wrong 1', 'wrong 2', 'wrong 3'], 'A');
  // Position 0 shows written 2, 1 shows 0, 2 shows 3, 3 shows 1.
  const shown = present(q, [2, 0, 3, 1]);
  assert.deepEqual(shown.options.map((o) => o.text), ['wrong 2', 'right', 'wrong 3', 'wrong 1']);
  assert.deepEqual(shown.options.map((o) => o.letter), ['A', 'B', 'C', 'D']);
  assert.equal(shown.answer, 'B');
  // Everything that is not the options is untouched, and the input is not mutated.
  assert.equal(shown.id, q.id);
  assert.equal(shown.prompt, q.prompt);
  assert.equal(q.answer, 'A');
  assert.deepEqual(q.options.map((o) => o.text), ['right', 'wrong 1', 'wrong 2', 'wrong 3']);
});

test('aShownLetterTranslatesBackToTheWrittenOne', () => {
  const q = mcq(['right', 'w1', 'w2', 'w3']);
  const order = [2, 0, 3, 1];
  assert.equal(writtenLetter('B', q, order), 'A');
  assert.equal(writtenLetter('A', q, order), 'C');
  assert.equal(writtenLetter('D', q, order), 'B');
  assert.equal(writtenLetter('Z', q, order), null);
});

test('anOrderThatNoLongerFitsIsIgnored', () => {
  const q = mcq(['a', 'b', 'c']);
  assert.deepEqual(present(q, [3, 2, 1, 0]), q);
  assert.deepEqual(present(q, [0, 0, 1]), q);
  assert.deepEqual(present(q, [0, 1, 3]), q);
  assert.equal(writtenLetter('A', q, [0, 1]), null);
  assert.equal(writtenLetter('A', q, [0, 0, 1]), null);
});

test('isPinned matches the group phrases case-insensitively', () => {
  for (const t of ['All of the above', 'None of these', 'ALL OF THEM', 'none of them',
    'All are correct', 'None are correct', 'Neither of the two']) {
    assert.equal(isPinned(t), true, t);
  }
  assert.equal(isPinned('Vitamin A'), false);
});

test('isTrueFalsePair trims whitespace and unicode punctuation', () => {
  assert.equal(isTrueFalsePair(mcq(['  True. ', '“False”!'])), true);
  assert.equal(isTrueFalsePair(mcq(['True', 'True'])), false);
  assert.equal(isTrueFalsePair(mcq(['True', 'False', 'Maybe'])), false);
  assert.equal(isTrueFalsePair(mcq(['Yes', 'No'])), false);
});

test('refersToOtherOptions edge cases', () => {
  assert.equal(refersToOtherOptions(mcq(['x', 'y', 'z', 'Both A and C'])), true);
  // Standalone capitals must also be option letters: "Vitamin A or I" has only A.
  assert.equal(refersToOtherOptions(mcq(['Vitamin A or I', 'b', 'c'])), false);
  // Picker word with a non-option capital still counts (eager).
  assert.equal(refersToOtherOptions(mcq(['Option Z', 'b'])), true);
  // Unicode: an accented letter next to a capital is not standalone.
  assert.equal(refersToOtherOptions(mcq(['Aé and Bé', 'b'])), false);
});

test('shuffled ignores one-option, non-mcq and pinned-only questions', () => {
  const g = splitMix(9);
  assert.deepEqual(shuffled(mcq(['only']), g), [0]);
  assert.deepEqual(shuffled({ ...mcq(['a', 'b', 'c']), type: 'open' }, g), [0, 1, 2]);
  assert.deepEqual(shuffled(mcq(['a', 'All of the above', 'None of these']), g), [0, 1, 2]);
});

test('shuffled defaults to Math.random', () => {
  const order = shuffled(mcq(['a', 'b', 'c', 'd']));
  assert.deepEqual(sorted(order), [0, 1, 2, 3]);
});
