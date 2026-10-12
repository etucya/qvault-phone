// Drives one study session: which question is next, and what happens after an answer.
// A port of QVaultKit's SessionEngine; inventory §2 is the rulebook.
//
// In memory, every date is a Date: `state.startedAt`, `state.availableAt[id]`, and each
// attempt's `at`. `encodeState` / `decodeState` convert to and from the `.quiz` JSON,
// where dates are ISO-8601 whole seconds.

import { decodeSettings, encodeSettings, scopedIDs, delayMode } from './settings.js';
import { isoSeconds, parseISO } from './dates.js';

/** Fisher–Yates from the back, on a copy. */
export function shuffle(items, random = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// MARK: - Derived counts (SessionState's computed properties)

/** Questions still left: the whole queue, including anything before the cursor. */
export const remaining = (state) => state.queue.length;
/** Questions cleared this session. */
export const clearedCount = (state) => state.retired.length;
/** What the session started with: cleared plus still to go. Never `answered`. */
export const totalCount = (state) => state.retired.length + state.queue.length;
/** Fraction finished, 0…1; zero for an empty session. */
export function progress(state) {
  const total = totalCount(state);
  return total === 0 ? 0 : clearedCount(state) / total;
}

function newState(startedAt, settings, queue) {
  return {
    startedAt: new Date(startedAt),
    settings,
    queue,
    position: 0,
    retired: [],
    missed: [],
    streaks: {},
    availableAt: {},
    answered: 0,
    activeMs: 0,
  };
}

const wholeMs = (ms) => (Number.isFinite(ms) ? Math.round(ms) : 0);

class SessionEngine {
  constructor(set, state) {
    /** The questions and their history. To save, use `persistableSet()`. */
    this.set = set;
    this.state = state;
    /** Snapshots taken before each answer: `{state, questionID}`. Never saved. */
    this.undoStack = [];
  }

  // MARK: Reading

  isFinished() {
    const cap = this.state.settings.maxQuestions;
    if (cap !== null && cap !== undefined && this.state.answered >= cap) return true;
    return this.state.queue.length === 0;
  }

  /** The question up next, or null when finished or when its id is no longer in the set. */
  current() {
    if (this.isFinished() || this.state.position >= this.state.queue.length) return null;
    const id = this.state.queue[this.state.position];
    return this.set.questions.find((q) => q.id === id) ?? null;
  }

  /** How many queued questions are there only because they were missed. */
  repeatingCount() {
    const missed = new Set(this.state.missed);
    return this.state.queue.filter((id) => missed.has(id)).length;
  }

  counts() {
    return {
      cleared: clearedCount(this.state),
      repeating: this.repeatingCount(),
      total: totalCount(this.state),
      remaining: remaining(this.state),
    };
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  /** A copy of the set with the live session attached, or `session: null` once finished. */
  persistableSet() {
    const copy = structuredClone(this.set);
    copy.session = this.isFinished() ? null : structuredClone(this.state);
    return copy;
  }

  /** How long this session has been actively studied, carried by the next save. */
  recordActiveTime(ms) {
    this.state.activeMs = Math.max(0, wholeMs(ms));
  }

  // MARK: Answering

  answer(outcome, chose = null, ms = 0, now = new Date()) {
    const { state } = this;
    if (this.isFinished() || state.position >= state.queue.length) {
      return { retired: false, requeued: false, finished: true };
    }
    const id = state.queue[state.position];

    this.undoStack.push({ state: structuredClone(state), questionID: id });

    const question = this.set.questions.find((q) => q.id === id);
    if (question) {
      const attempt = { at: new Date(now), outcome, ms: wholeMs(ms) };
      if (outcome !== 'dontknow' && chose !== null && chose !== undefined) attempt.chose = chose;
      question.stats ??= { attempts: [] };
      question.stats.attempts ??= [];
      question.stats.attempts.push(attempt);
    }
    state.answered += 1;

    let retired = false;
    if (outcome === 'correct') {
      if (state.missed.includes(id)) {
        const streak = (state.streaks[id] ?? 0) + 1;
        state.streaks[id] = streak;
        if (streak >= state.settings.retireThreshold) {
          this.#retireCurrent(id);
          retired = true;
        } else {
          this.#requeueCurrent(now);
        }
      } else {
        // Never missed this session: one right answer clears it, whatever the threshold.
        this.#retireCurrent(id);
        retired = true;
      }
    } else {
      state.streaks[id] = 0;
      if (!state.missed.includes(id)) state.missed.push(id);
      this.#requeueCurrent(now);
    }

    this.#normalizePosition(now);
    return { retired, requeued: !retired, finished: this.isFinished() };
  }

  /** Move past the current question without recording anything. Not undoable. */
  skip(now = new Date()) {
    const { state } = this;
    if (this.isFinished() || state.position >= state.queue.length) return;
    const [id] = state.queue.splice(state.position, 1);
    state.queue.push(id);
    this.#normalizePosition(now);
  }

  /** Rolls back the last answer completely: the attempt, streak, retirement and position. */
  undoLastAnswer() {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    const question = this.set.questions.find((q) => q.id === snapshot.questionID);
    if (question?.stats?.attempts?.length) question.stats.attempts.pop();
    this.state = snapshot.state;
    return true;
  }

  // MARK: Editing

  /** Flips `flagged` on the named question. No session or undo change. */
  toggleFlag(questionID) {
    const question = this.set.questions.find((q) => q.id === questionID);
    if (!question) return false;
    question.flagged = !question.flagged;
    return true;
  }

  /** Replaces a question's content, keeping its id and its history. */
  update(questionID, edited) {
    const index = this.set.questions.findIndex((q) => q.id === questionID);
    if (index < 0) return false;
    const replacement = structuredClone(edited);
    replacement.id = questionID;
    replacement.stats = this.set.questions[index].stats;
    this.set.questions[index] = replacement;
    return true;
  }

  /** Removes a question from the set and every trace of it from the session. Clears undo. */
  removeQuestion(id) {
    const index = this.set.questions.findIndex((q) => q.id === id);
    if (index < 0) return false;
    this.set.questions.splice(index, 1);

    const { state } = this;
    const removedBeforeCursor = state.queue.slice(0, state.position).includes(id);
    state.queue = state.queue.filter((x) => x !== id);
    state.retired = state.retired.filter((x) => x !== id);
    state.missed = state.missed.filter((x) => x !== id);
    delete state.streaks[id];
    delete state.availableAt[id];

    if (removedBeforeCursor) state.position -= 1;
    if (state.position >= state.queue.length) state.position = 0;

    this.undoStack = [];
    return true;
  }

  // MARK: Queue mechanics

  #retireCurrent(id) {
    this.state.queue.splice(this.state.position, 1);
    this.state.retired.push(id);
    delete this.state.availableAt[id];
  }

  #requeueCurrent(now) {
    const { state } = this;
    const [id] = state.queue.splice(state.position, 1);
    const { delay } = state.settings;
    switch (delayMode(delay)) {
      case 'minutes':
        state.availableAt[id] = new Date(now.getTime() + delay.minutes * 60_000);
        state.queue.push(id);
        break;
      case 'endOfSet':
        state.queue.push(id);
        break;
      default: {
        // A hand-edited file could hold any number. 1 is the smallest gap that still moves on.
        const gap = Math.max(1, delay.questions);
        state.queue.splice(Math.min(state.position + gap, state.queue.length), 0, id);
      }
    }
  }

  /** Keeps `position` on a question that may actually be shown. */
  #normalizePosition(now) {
    const { state } = this;
    if (state.queue.length === 0) { state.position = 0; return; }
    if (state.position >= state.queue.length) state.position = 0;

    if (delayMode(state.settings.delay) !== 'minutes') return;

    const count = state.queue.length;
    const dueAt = (id) => state.availableAt[id]?.getTime() ?? -Infinity;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (state.position + offset) % count;
      if (dueAt(state.queue[index]) <= now.getTime()) {
        state.position = index;
        return;
      }
    }
    // Everything is waiting: serve whichever is due soonest (first on a tie).
    let soonest = 0;
    for (let index = 1; index < count; index += 1) {
      if (dueAt(state.queue[index]) < dueAt(state.queue[soonest])) soonest = index;
    }
    state.position = soonest;
  }

  /** Called by resumeSession after it rebuilds the queue. */
  normalizePosition(now = new Date()) {
    this.#normalizePosition(now);
  }
}

/** An engine over a set and a state as they are, with no normalising. Copies both. */
export function createEngine(set, state) {
  return new SessionEngine(structuredClone(set), structuredClone(state));
}

/** A fresh session: the scoped ids, shuffled when the order says so. */
export function startSession(set, settings, now = new Date(), random = Math.random) {
  const decoded = decodeSettings(settings);
  let ids = scopedIDs(set.questions, decoded);
  if (decoded.order === 'shuffle') ids = shuffle(ids, random);
  return new SessionEngine(structuredClone(set), newState(now, decoded, ids));
}

/**
 * Picks a saved session back up under the settings just chosen. Only order, delay, retire
 * threshold, stop-after and option shuffling are taken from them; scope, range and tags
 * describe how the queue was built and keep their saved values. The whole queue is
 * reordered and the cursor goes back to the front. Everything earned is kept, so the
 * stop-after cap counts across sittings.
 */
export function resumeSession(set, state, settings, now = new Date(), random = Math.random) {
  const chosen = decodeSettings(settings);
  const resumed = structuredClone(state);
  resumed.settings = decodeSettings(resumed.settings);
  resumed.settings.order = chosen.order;
  resumed.settings.delay = chosen.delay;
  resumed.settings.retireThreshold = chosen.retireThreshold;
  resumed.settings.maxQuestions = chosen.maxQuestions;
  resumed.settings.shuffleOptions = chosen.shuffleOptions;

  if (chosen.order === 'shuffle') {
    resumed.queue = shuffle(resumed.queue, random);
  } else {
    const place = new Map();
    set.questions.forEach((q, i) => { if (!place.has(q.id)) place.set(q.id, i); });
    const rank = (id) => place.get(id) ?? Infinity;
    resumed.queue = [...resumed.queue].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra === rb ? 0 : (ra < rb ? -1 : 1);
    });
  }
  resumed.position = 0;

  const engine = new SessionEngine(structuredClone(set), resumed);
  engine.normalizePosition(now);
  return engine;
}

// MARK: - SessionState JSON

function required(json, key) {
  const value = json?.[key];
  if (value === undefined || value === null) throw new TypeError(`Saved session is missing ${key}`);
  return value;
}

function ids(value, key) {
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new TypeError(`Saved session ${key} is not a list of ids`);
  }
  return [...value];
}

function int(value, key) {
  if (!Number.isInteger(value)) throw new TypeError(`Saved session ${key} is not a whole number`);
  return value;
}

function dictionary(value, key) {
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Saved session ${key} is not a dictionary`);
  return value;
}

const mapValues = (object, f) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, f(v, k)]));

/** Reads a saved SessionState. Everything is required except `activeMs`, which reads as 0. */
export function decodeState(json) {
  return {
    startedAt: parseISO(required(json, 'startedAt')),
    settings: decodeSettings(required(json, 'settings')),
    queue: ids(required(json, 'queue'), 'queue'),
    position: int(required(json, 'position'), 'position'),
    retired: ids(required(json, 'retired'), 'retired'),
    missed: ids(required(json, 'missed'), 'missed'),
    streaks: mapValues(dictionary(required(json, 'streaks'), 'streaks'), (v, k) => int(v, `streaks.${k}`)),
    availableAt: mapValues(dictionary(required(json, 'availableAt'), 'availableAt'), (v) => parseISO(v)),
    answered: int(required(json, 'answered'), 'answered'),
    activeMs: json.activeMs === undefined || json.activeMs === null ? 0 : int(json.activeMs, 'activeMs'),
  };
}

const sortedEntries = (object) => Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The SessionState as the Mac writes it: keys sorted, dates as ISO whole seconds. */
export function encodeState(state) {
  return {
    activeMs: state.activeMs ?? 0,
    answered: state.answered,
    availableAt: Object.fromEntries(sortedEntries(state.availableAt).map(([k, v]) => [k, isoSeconds(v)])),
    missed: [...state.missed],
    position: state.position,
    queue: [...state.queue],
    retired: [...state.retired],
    settings: encodeSettings(state.settings),
    startedAt: isoSeconds(state.startedAt),
    streaks: Object.fromEntries(sortedEntries(state.streaks)),
  };
}
