// Session settings: what to study, in what order, and how missed questions come back.
// Mirrors QVaultKit's SessionSettings, including the way Swift encodes them inside a
// `.quiz` file's saved session.
//
// In memory a delay is `{questions: n}`, `{minutes: n}` or `{endOfSet: true}`. In JSON it
// uses Swift's synthesized enum encoding: `{"questions":{"_0":5}}`, `{"minutes":{"_0":10}}`,
// `{"endOfSet":{}}`. `tags` is a set: kept sorted and without repeats.

export const SCOPES = ['all', 'unseen', 'missed', 'flagged', 'range'];
export const ORDERS = ['shuffle', 'original'];

export const DEFAULT_SETTINGS = Object.freeze({
  scope: 'all',
  rangeLower: null,
  rangeUpper: null,
  order: 'shuffle',
  delay: Object.freeze({ questions: 5 }),
  retireThreshold: 1,
  maxQuestions: null,
  tags: Object.freeze([]),
  shuffleOptions: true,
});

const present = (value) => value !== undefined && value !== null;

function int(value, key) {
  if (!Number.isInteger(value)) throw new TypeError(`Setting ${key} is not a whole number: ${JSON.stringify(value)}`);
  return value;
}

function bool(value, key) {
  if (typeof value !== 'boolean') throw new TypeError(`Setting ${key} is not true or false: ${JSON.stringify(value)}`);
  return value;
}

function oneOf(value, allowed, key) {
  if (!allowed.includes(value)) throw new TypeError(`Setting ${key} is not one of ${allowed.join(', ')}: ${JSON.stringify(value)}`);
  return value;
}

/** The payload of a delay case: a bare number (in memory) or Swift's `{"_0": n}`. */
function delayValue(value, mode) {
  if (value !== null && typeof value === 'object' && '_0' in value) return int(value._0, `delay.${mode}`);
  return int(value, `delay.${mode}`);
}

function decodeDelay(delay) {
  if (delay === null || typeof delay !== 'object') throw new TypeError(`Setting delay is not readable: ${JSON.stringify(delay)}`);
  const keys = Object.keys(delay);
  if (keys.length === 1) {
    const [mode] = keys;
    if (mode === 'questions') return { questions: delayValue(delay.questions, mode) };
    if (mode === 'minutes') return { minutes: delayValue(delay.minutes, mode) };
    if (mode === 'endOfSet') return { endOfSet: true };
  }
  throw new TypeError(`Setting delay is not readable: ${JSON.stringify(delay)}`);
}

/** `'questions' | 'minutes' | 'endOfSet'` */
export function delayMode(delay) {
  if ('minutes' in delay) return 'minutes';
  if ('endOfSet' in delay) return 'endOfSet';
  return 'questions';
}

function decodeTags(tags) {
  const list = tags instanceof Set ? [...tags] : tags;
  if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) {
    throw new TypeError(`Setting tags is not a list of names: ${JSON.stringify(tags)}`);
  }
  return [...new Set(list)].sort();
}

/**
 * Reads settings saved by the Mac (Swift encoding) or held in memory (internal shape).
 * Every key is optional; a missing or null key reads as its default. A value the Mac
 * itself could not read (an unknown scope, a fractional count) throws.
 */
export function decodeSettings(json) {
  const s = json ?? {};
  return {
    scope: present(s.scope) ? oneOf(s.scope, SCOPES, 'scope') : DEFAULT_SETTINGS.scope,
    rangeLower: present(s.rangeLower) ? int(s.rangeLower, 'rangeLower') : null,
    rangeUpper: present(s.rangeUpper) ? int(s.rangeUpper, 'rangeUpper') : null,
    order: present(s.order) ? oneOf(s.order, ORDERS, 'order') : DEFAULT_SETTINGS.order,
    delay: present(s.delay) ? decodeDelay(s.delay) : { ...DEFAULT_SETTINGS.delay },
    retireThreshold: present(s.retireThreshold)
      ? int(s.retireThreshold, 'retireThreshold') : DEFAULT_SETTINGS.retireThreshold,
    maxQuestions: present(s.maxQuestions) ? int(s.maxQuestions, 'maxQuestions') : null,
    tags: present(s.tags) ? decodeTags(s.tags) : [],
    shuffleOptions: present(s.shuffleOptions)
      ? bool(s.shuffleOptions, 'shuffleOptions') : DEFAULT_SETTINGS.shuffleOptions,
  };
}

function encodeDelay(delay) {
  switch (delayMode(delay)) {
    case 'minutes': return { minutes: { _0: delay.minutes } };
    case 'endOfSet': return { endOfSet: {} };
    default: return { questions: { _0: delay.questions } };
  }
}

/** The Swift encoding, keys sorted, empty optionals left out. */
export function encodeSettings(settings) {
  const s = decodeSettings(settings);
  const json = { delay: encodeDelay(s.delay) };
  if (s.maxQuestions !== null) json.maxQuestions = s.maxQuestions;
  json.order = s.order;
  if (s.rangeLower !== null) json.rangeLower = s.rangeLower;
  if (s.rangeUpper !== null) json.rangeUpper = s.rangeUpper;
  json.retireThreshold = s.retireThreshold;
  json.scope = s.scope;
  json.shuffleOptions = s.shuffleOptions;
  json.tags = s.tags;
  return json;
}

/**
 * The questions carrying at least one of `tags`, in file order. A chosen tag no question
 * carries any more is ignored; if none are left, every question.
 */
export function questionsTagged(questions, tags) {
  const carried = new Set(questions.flatMap((q) => q.tags ?? []));
  const live = new Set([...(tags ?? [])].filter((t) => carried.has(t)));
  if (live.size === 0) return questions;
  return questions.filter((q) => (q.tags ?? []).some((t) => live.has(t)));
}

const isMiss = (attempt) => attempt.outcome === 'wrong' || attempt.outcome === 'dontknow';

/** The ids a fresh session is built from, in file order: tags narrow first, then scope. */
export function scopedIDs(questions, settings) {
  const s = decodeSettings(settings);
  const pool = questionsTagged(questions, s.tags);
  const attempts = (q) => q.stats?.attempts ?? [];
  switch (s.scope) {
    case 'unseen': return pool.filter((q) => attempts(q).length === 0).map((q) => q.id);
    case 'missed': return pool.filter((q) => attempts(q).some(isMiss)).map((q) => q.id);
    case 'flagged': return pool.filter((q) => q.flagged === true).map((q) => q.id);
    case 'range': {
      const lo = Math.max(1, s.rangeLower ?? 1);
      const hi = Math.min(pool.length, s.rangeUpper ?? pool.length);
      if (lo > hi) return [];
      return pool.slice(lo - 1, hi).map((q) => q.id);
    }
    default: return pool.map((q) => q.id);
  }
}
