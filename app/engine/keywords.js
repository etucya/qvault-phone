// Port of the keyword logic in StudyModel.matchedKeywords and OpenQuestionView's
// HighlightedText/WordChip (inventory section 6). Informational only: keywords
// never grade an answer.

const PUNCT = /\p{P}/u;

/// Each keyword, in order, is a hit if the lowercased typed answer contains the
/// lowercased keyword as a substring.
export function keywordHits(typed, keywords) {
  const lowered = typed.toLowerCase();
  return keywords.map((keyword) => ({
    keyword,
    hit: lowered.includes(keyword.toLowerCase()),
  }));
}

/// Splits `answerText` into `[{text, highlighted}]` whose texts concatenate back to
/// exactly `answerText`. Words are split on U+0020 only. Only the core of a word
/// (Unicode punctuation trimmed from both ends) is highlighted, and only when its
/// lowercased form contains a hit keyword as a substring. Spaces and punctuation
/// are kept in unhighlighted segments; neighbouring unhighlighted text is merged.
export function highlightSegments(answerText, hitKeywords) {
  const needles = hitKeywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  const segments = [];

  const push = (text, highlighted) => {
    if (text === '') return;
    const last = segments[segments.length - 1];
    if (last && last.highlighted === highlighted && !highlighted) {
      last.text += text;
    } else {
      segments.push({ text, highlighted });
    }
  };

  // Keep the spaces as their own pieces so nothing is lost.
  for (const piece of answerText.split(/( +)/)) {
    if (piece === '') continue;
    if (piece[0] === ' ') {
      push(piece, false);
      continue;
    }
    const chars = Array.from(piece);
    let start = 0;
    while (start < chars.length && PUNCT.test(chars[start])) start += 1;
    let end = chars.length;
    while (end > start && PUNCT.test(chars[end - 1])) end -= 1;

    const leading = chars.slice(0, start).join('');
    const core = chars.slice(start, end).join('');
    const trailing = chars.slice(end).join('');

    const lowered = core.toLowerCase();
    const highlighted = core !== '' && needles.some((n) => lowered.includes(n));

    push(leading, false);
    push(core, highlighted);
    push(trailing, false);
  }
  return segments;
}
