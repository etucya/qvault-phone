// A `.quiz` file to and from memory (inventory §1). In memory every date is a Date and
// optional fields are simply absent; on the way out keys are sorted as the Mac writes
// them, empty optionals are left out, and dates are ISO-8601 whole seconds.

import { isoSeconds, parseISO } from './dates.js';
import { decodeState, encodeState } from './sessionEngine.js';

const TYPES = ['mcq', 'tf', 'open'];
const OUTCOMES = ['correct', 'shaky', 'wrong', 'dontknow'];
const OPTIONAL_TEXT = ['answer', 'answerText', 'explanation', 'note', 'image'];

const present = (value) => value !== undefined && value !== null;

function required(json, key, where) {
  const value = json?.[key];
  if (!present(value)) throw new TypeError(`${where} is missing ${key}`);
  return value;
}

function string(value, key) {
  if (typeof value !== 'string') throw new TypeError(`${key} is not text`);
  return value;
}

function strings(value, key) {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new TypeError(`${key} is not a list of text`);
  }
  return [...value];
}

function int(value, key) {
  if (!Number.isInteger(value)) throw new TypeError(`${key} is not a whole number`);
  return value;
}

function decodeAttempt(json) {
  const outcome = required(json, 'outcome', 'An attempt');
  if (!OUTCOMES.includes(outcome)) throw new TypeError(`Unknown outcome ${JSON.stringify(outcome)}`);
  const attempt = {
    at: parseISO(required(json, 'at', 'An attempt')),
    outcome,
    ms: int(required(json, 'ms', 'An attempt'), 'ms'),
  };
  if (present(json.chose)) attempt.chose = string(json.chose, 'chose');
  return attempt;
}

export function decodeQuestion(json) {
  const type = required(json, 'type', 'A question');
  if (!TYPES.includes(type)) throw new TypeError(`Unknown question type ${JSON.stringify(type)}`);
  const question = {
    id: string(required(json, 'id', 'A question'), 'id'),
    type,
    prompt: string(required(json, 'prompt', 'A question'), 'prompt'),
    options: present(json.options)
      ? json.options.map((o) => ({
        letter: string(required(o, 'letter', 'An option'), 'letter'),
        text: string(required(o, 'text', 'An option'), 'text'),
      }))
      : [],
    keywords: present(json.keywords) ? strings(json.keywords, 'keywords') : [],
    tags: present(json.tags) ? strings(json.tags, 'tags') : [],
    flagged: present(json.flagged) ? json.flagged === true : false,
    stats: {
      attempts: present(json.stats?.attempts) ? json.stats.attempts.map(decodeAttempt) : [],
    },
  };
  for (const key of OPTIONAL_TEXT) {
    if (present(json[key])) question[key] = string(json[key], key);
  }
  return question;
}

/** Reads a `.quiz` file from its text or its parsed JSON. Throws on a damaged file. */
export function decodeSet(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const set = {
    schema: int(required(data, 'schema', 'The file'), 'schema'),
    name: string(required(data, 'name', 'The file'), 'name'),
    created: parseISO(required(data, 'created', 'The file')),
    modified: parseISO(required(data, 'modified', 'The file')),
    questions: required(data, 'questions', 'The file').map(decodeQuestion),
  };
  if (present(data.source)) set.source = string(data.source, 'source');
  if (present(data.session)) set.session = decodeState(data.session);
  return set;
}

function encodeAttempt(attempt) {
  const json = { at: isoSeconds(attempt.at) };
  if (present(attempt.chose)) json.chose = attempt.chose;
  json.ms = attempt.ms;
  json.outcome = attempt.outcome;
  return json;
}

const isCorrect = (attempt) => attempt.outcome === 'correct' || attempt.outcome === 'shaky';

export function encodeQuestion(q) {
  const attempts = q.stats?.attempts ?? [];
  const json = {};
  if (present(q.answer)) json.answer = q.answer;
  if (present(q.answerText)) json.answerText = q.answerText;
  if (present(q.explanation)) json.explanation = q.explanation;
  json.flagged = q.flagged === true;
  json.id = q.id;
  if (present(q.image)) json.image = q.image;
  json.keywords = [...(q.keywords ?? [])];
  if (present(q.note)) json.note = q.note;
  json.options = (q.options ?? []).map((o) => ({ letter: o.letter, text: o.text }));
  json.prompt = q.prompt;
  json.stats = {
    attempts: attempts.map(encodeAttempt),
    correct: attempts.filter(isCorrect).length,
    seen: attempts.length,
  };
  json.tags = [...(q.tags ?? [])];
  json.type = q.type;
  return json;
}

/** The `.quiz` JSON for a set, ready for `JSON.stringify(…, null, 2)`. */
export function encodeSet(set) {
  const json = {
    created: isoSeconds(set.created),
    modified: isoSeconds(set.modified),
    name: set.name,
    questions: set.questions.map(encodeQuestion),
    schema: set.schema ?? 1,
  };
  if (present(set.session)) json.session = encodeState(set.session);
  if (present(set.source)) json.source = set.source;
  return json;
}
