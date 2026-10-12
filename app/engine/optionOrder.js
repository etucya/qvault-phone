// The order a multiple-choice question's options are *shown* in, as distinct from the
// order they are *written* in.
//
// An order is a list of indexes into the question's options as written: position `i`
// on screen shows written option `order[i]`. Letters stay attached to positions, so the
// first option on screen is always A; a question is shown by moving the texts under the
// letters, and its answer moves with its text. Nothing here mutates a question.

const PINNED_PHRASES = [
  'the above', 'of these', 'all of them', 'none of them',
  'all are correct', 'none are correct', 'neither of',
];

const PICKER = /\b([Bb]oth|[Oo]nly|[Cc]hoices?|[Oo]ptions?|[Aa]nswers?)\s+[A-Z]\b/;
const LETTER = /\p{L}/u;
const UPPER = /\p{Lu}/u;
const EDGE_PUNCTUATION = /^[\s\p{P}]+|[\s\p{P}]+$/gu;

/** Written order, unchanged. */
export function identity(question) {
  return question.options.map((_, i) => i);
}

/**
 * A fresh order for showing `question` once. Written order is returned for anything that
 * is not multiple choice, has fewer than two options, refers to its own options by
 * letter, or is a True/False pair. Pinned options ("All of the above") keep their place.
 */
export function shuffled(question, random = Math.random) {
  const written = identity(question);
  if (question.type !== 'mcq' || question.options.length < 2
    || refersToOtherOptions(question) || isTrueFalsePair(question)) {
    return written;
  }

  const movable = written.filter((i) => !isPinned(question.options[i].text));
  if (movable.length < 2) return written;

  if (movable.length === 2) {
    const order = [...written];
    if (random() < 0.5) {
      [order[movable[0]], order[movable[1]]] = [order[movable[1]], order[movable[0]]];
    }
    return order;
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const pool = fisherYates(movable, random);
    const order = [...written];
    movable.forEach((slot, k) => { order[slot] = pool[k]; });
    if (order.some((v, i) => v !== written[i])) return order;
  }
  return written;
}

function fisherYates(items, random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A two-option question whose options are True and False in some spelling, either order. */
export function isTrueFalsePair(question) {
  if (question.options.length !== 2) return false;
  const texts = new Set(question.options.map(
    (o) => o.text.replace(EDGE_PUNCTUATION, '').toLowerCase(),
  ));
  return texts.size === 2 && texts.has('true') && texts.has('false');
}

function isValid(order, question) {
  const n = question.options.length;
  if (!Array.isArray(order) || order.length !== n) return false;
  const seen = new Set(order);
  if (seen.size !== n) return false;
  for (let i = 0; i < n; i++) if (!seen.has(i)) return false;
  return true;
}

/**
 * `question` as it should appear on screen under `order`: a copy with the option texts
 * moved under their positional letters and the answer letter following its text. An
 * order that is not a permutation of this question's options is ignored.
 */
export function present(question, order) {
  if (!isValid(order, question)) return question;
  const shown = {
    ...question,
    options: question.options.map((o, p) => ({ ...o, letter: o.letter, text: question.options[order[p]].text })),
  };
  const writtenIndex = question.options.findIndex((o) => o.letter === question.answer);
  if (question.answer != null && writtenIndex >= 0) {
    const shownIndex = order.indexOf(writtenIndex);
    if (shownIndex >= 0) shown.answer = question.options[shownIndex].letter;
  }
  return shown;
}

/** The letter, as written in the file, of the option shown under `shownLetter`; null if unknown. */
export function writtenLetter(shownLetter, question, order) {
  if (!isValid(order, question)) return null;
  const position = question.options.findIndex((o) => o.letter === shownLetter);
  if (position < 0) return null;
  return question.options[order[position]].letter;
}

/** An option that only makes sense in its written place ("All of the above"). */
export function isPinned(text) {
  const lowered = text.toLowerCase();
  return PINNED_PHRASES.some((p) => lowered.includes(p));
}

/**
 * Whether any option names another by its letter: two standalone option letters in one
 * option ("A and C"), or a letter after a picking word ("Only B"). Deliberately eager.
 */
export function refersToOtherOptions(question) {
  const letters = new Set(question.options.map((o) => o.letter));
  for (const option of question.options) {
    let count = 0;
    for (const c of standaloneCapitals(option.text)) if (letters.has(c)) count++;
    if (count >= 2) return true;
    if (PICKER.test(option.text)) return true;
  }
  return false;
}

/** Capital letters standing on their own: "A" in "A and B", not the "I" in "II". */
function standaloneCapitals(text) {
  const chars = [...text];
  const found = new Set();
  chars.forEach((ch, i) => {
    if (!UPPER.test(ch)) return;
    const before = i > 0 && LETTER.test(chars[i - 1]);
    const after = i + 1 < chars.length && LETTER.test(chars[i + 1]);
    if (!before && !after) found.add(ch);
  });
  return found;
}
