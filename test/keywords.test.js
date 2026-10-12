import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordHits, highlightSegments } from '../app/engine/keywords.js';

test('keywordMatchingSplitsHitFromMissed', () => {
  const result = keywordHits('bacteria and FUNGI', ['bacteria', 'archaea', 'fungi']);
  assert.deepEqual(result, [
    { keyword: 'bacteria', hit: true },
    { keyword: 'archaea', hit: false },
    { keyword: 'fungi', hit: true },
  ]);
});

test('keywordHitsIsASubstringMatchAndKeepsKeywordOrderAndCase', () => {
  const result = keywordHits('photosynthesis', ['Photo', 'synth', 'respiration']);
  assert.deepEqual(result.map((r) => r.keyword), ['Photo', 'synth', 'respiration']);
  assert.deepEqual(result.map((r) => r.hit), [true, true, false]);
});

test('keywordHitsWithNoKeywordsIsEmpty', () => {
  assert.deepEqual(keywordHits('anything', []), []);
});

const join = (segments) => segments.map((s) => s.text).join('');

test('highlightsOnlyTheCoreWordAndLeavesPunctuationOutside', () => {
  const segments = highlightSegments('Bacteria, archaea, and fungi.', ['bacteria', 'fungi']);
  assert.equal(join(segments), 'Bacteria, archaea, and fungi.');
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['Bacteria', 'fungi']);
  assert.deepEqual(segments[1], { text: ', archaea, and ', highlighted: false });
});

test('punctuationAroundTheWordSitsOutsideTheHighlight', () => {
  const segments = highlightSegments('(fungi)', ['fungi']);
  assert.deepEqual(segments, [
    { text: '(', highlighted: false },
    { text: 'fungi', highlighted: true },
    { text: ')', highlighted: false },
  ]);
});

test('internalPunctuationStaysInsideTheCore', () => {
  const segments = highlightSegments("it's a self-check", ['self-check']);
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['self-check']);
});

test('matchingIsCaseInsensitiveAndSubstringBased', () => {
  const segments = highlightSegments('Photosynthesis happens', ['SYNTH']);
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['Photosynthesis']);
});

test('aMultiWordKeywordNeverHighlights', () => {
  const segments = highlightSegments('the cell membrane is thin', ['cell membrane']);
  assert.equal(segments.some((s) => s.highlighted), false);
  assert.equal(join(segments), 'the cell membrane is thin');
});

test('noHitKeywordsMeansOneUnhighlightedSegment', () => {
  const segments = highlightSegments('Some answer text.', []);
  assert.equal(segments.some((s) => s.highlighted), false);
  assert.equal(join(segments), 'Some answer text.');
});

test('aWordOfPurePunctuationIsNeverHighlighted', () => {
  const segments = highlightSegments('a -- b', ['-']);
  assert.equal(segments.some((s) => s.highlighted), false);
  assert.equal(join(segments), 'a -- b');
});

test('concatenationIsExactEvenWithRepeatedLeadingAndTrailingSpaces', () => {
  const text = '  fungi,   and  bacteria!  ';
  const segments = highlightSegments(text, ['fungi', 'bacteria']);
  assert.equal(join(segments), text);
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['fungi', 'bacteria']);
});

test('onlySpaceSplitsWords_tabsAndNewlinesStayInsideAWord', () => {
  // U+0020 only: "a\tfungi" is one word whose core contains the keyword.
  const segments = highlightSegments('a\tfungi b', ['fungi']);
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['a\tfungi']);
  assert.equal(join(segments), 'a\tfungi b');
});

test('unicodePunctuationIsTrimmed', () => {
  const segments = highlightSegments('«fungi» “bacteria”', ['fungi', 'bacteria']);
  assert.deepEqual(segments.filter((s) => s.highlighted).map((s) => s.text), ['fungi', 'bacteria']);
  assert.equal(join(segments), '«fungi» “bacteria”');
});

test('emptyAnswerGivesNoSegments', () => {
  assert.deepEqual(highlightSegments('', ['x']), []);
});

test('anEmptyKeywordDoesNotHighlightEverything', () => {
  const segments = highlightSegments('some words', ['']);
  assert.equal(segments.some((s) => s.highlighted), false);
});
