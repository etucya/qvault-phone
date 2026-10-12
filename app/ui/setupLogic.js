// The setup sheet's rules, without the DOM: which key a bank's (or a pool's) settings and
// session live under, what the subtitle says, how many questions the choices add up to,
// and how Start, Resume and Start fresh build the study model and save it back through
// the store. Mirrors the Mac's SessionSetupSheet (QVaultApp/Session/SessionSetupSheet.swift).

import { decodeSettings, encodeSettings, questionsTagged, scopedIDs, delayMode } from '../engine/settings.js';
import { decodeState, encodeState } from '../engine/sessionEngine.js';
import { buildPool, writeBack } from '../engine/pool.js';
import { createStudyModel } from '../engine/studyModel.js';
import { pruneSession } from '../sync.js';
import { bankName } from './library.js';
import { plural } from './components.js';

const POOL_PREFIX = 'pool:';

/** A bank's own path; a pool's `pool:` plus its paths sorted and joined with `|`. */
export function settingsKey(paths) {
  if (paths.length === 1) return paths[0];
  return POOL_PREFIX + [...paths].sort().join('|');
}

/** Every tag the questions carry, alphabetically, each with how many questions carry it. */
export function tagOptions(questions) {
  const counts = new Map();
  for (const question of questions) {
    for (const tag of new Set(question.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((name) => ({ name, count: counts.get(name) }));
}

/** Settings with every remembered tag the questions no longer carry forgotten. */
export function pruneTags(settings, questions) {
  const carried = new Set(questions.flatMap((q) => q.tags ?? []));
  return { ...settings, tags: settings.tags.filter((tag) => carried.has(tag)) };
}

/** How many questions the tags alone leave: what the range counts within. */
export function taggedCount(questions, settings) {
  return questionsTagged(questions, settings.tags).length;
}

/** How many questions the choices add up to: the same function the session is built with. */
export function inScopeCount(questions, settings) {
  return scopedIDs(questions, settings).length;
}

/**
 * The range as the steppers show it: both ends within 1..max, where max is the tagged
 * count. A number picked earlier that is now too large shows clamped, as the session
 * clamps it.
 */
export function rangeBounds(questions, settings) {
  const max = taggedCount(questions, settings);
  if (max === 0) return { lower: 0, upper: 0, max };
  const upper = Math.min(Math.max(settings.rangeUpper ?? max, 1), max);
  const lower = Math.min(Math.max(settings.rangeLower ?? 1, 1), upper);
  return { lower, upper, max };
}

/**
 * The settings as the sheet shows them: a range start left above the (now smaller) end
 * is read as the end, so the count and the session agree with the two numbers on screen.
 */
export function effectiveSettings(questions, settings) {
  if (settings.scope !== 'range' || settings.rangeLower === null) return settings;
  const { lower, max } = rangeBounds(questions, settings);
  if (max === 0 || settings.rangeLower <= lower) return settings;
  return { ...settings, rangeLower: lower };
}

/** Every recorded answer across the questions. */
export function recordedAnswers(questions) {
  return questions.reduce((sum, q) => sum + (q.stats?.attempts?.length ?? 0), 0);
}

/**
 * "N questions" when everything is in scope, else "count of total questions"; plus, when
 * an unfinished session exists, "stopped with N questions to go". While resuming the count
 * is the whole set: the choices below do not decide the queue.
 */
export function subtitle({ total, inScope, resuming = false, remaining = null }) {
  const count = resuming ? total : inScope;
  let text = count === total ? plural(total, 'question') : `${count} of ${total} questions`;
  if (remaining !== null && remaining !== undefined) text += ` · stopped with ${plural(remaining, 'question')} to go`;
  return text;
}

// ---------------------------------------------------------------------------------------
// Repeat-missed delay

/** The smallest gap that still moves the queue, and the largest worth offering. */
export const DELAY_BOUNDS = Object.freeze({
  questions: Object.freeze({ min: 1, max: 99, default: 5 }),
  minutes: Object.freeze({ min: 1, max: 120, default: 10 }),
});

/** A delay of `mode` with `amount` held inside its bounds. */
export function delayOf(mode, amount) {
  if (mode === 'endOfSet') return { endOfSet: true };
  const bounds = DELAY_BOUNDS[mode];
  const value = Math.min(Math.max(Math.round(amount ?? bounds.default), bounds.min), bounds.max);
  return { [mode]: value };
}

export function delayHint(delay) {
  switch (delayMode(delay)) {
    case 'minutes': return `A missed question comes back after ${delay.minutes} minutes.`;
    case 'endOfSet': return 'Missed questions come back only after everything else in this session.';
    default: return `A missed question comes back after ${delay.questions} more questions go by.`;
  }
}

/** What the chosen tags amount to. */
export function tagHint(settings, options) {
  const chosen = options.filter((option) => settings.tags.includes(option.name));
  if (chosen.length === 0) return 'Pick one or more to study only those. Nothing picked studies every tag.';
  return `Only questions tagged ${chosen.map((o) => o.name).join(', ')}, on top of whichever choice is above.`;
}

// ---------------------------------------------------------------------------------------
// Loading and saving

/** Stored settings for `key`, read leniently: anything unreadable gives the defaults. */
export async function loadSettings(store, key) {
  try {
    return decodeSettings(await store.settings.get(key));
  } catch {
    return decodeSettings(null);
  }
}

export async function saveSettings(store, key, settings) {
  await store.settings.put(key, encodeSettings(settings));
}

/**
 * Everything the sheet shows for `paths`: the banks in library order (the order
 * `store.banks.list()` gives), the questions as they would be studied, the settings with
 * dead tags pruned (and saved so), and the saved session if one can be read.
 */
export async function loadSetup(store, paths) {
  const wanted = new Set(paths);
  const listed = (await store.banks.list()).filter((summary) => wanted.has(summary.path) && !summary.corrupt);
  const banks = (await Promise.all(listed.map((summary) => store.banks.get(summary.path)))).filter(Boolean);
  if (banks.length === 0) throw new Error('That bank is no longer on this phone.');

  const key = settingsKey(banks.map((bank) => bank.path));
  const pool = banks.length === 1 ? null : buildPool(banks);
  const questions = pool ? pool.questions : banks[0].questions;
  const title = pool ? plural(banks.length, 'bank') : bankName(banks[0]);

  const stored = await loadSettings(store, key);
  const settings = pruneTags(stored, questions);
  if (settings.tags.length !== stored.tags.length) await saveSettings(store, key, settings);

  let session = null;
  try {
    const raw = await store.sessions.get(key);
    if (raw) session = decodeState(raw);
  } catch {
    // A session that cannot be read is treated as none; starting replaces it.
    session = null;
  }
  if (session) session = await pruneSavedSession(store, key, session, questions);

  return { key, paths: banks.map((bank) => bank.path), title, banks, pool, questions, settings, session };
}

/**
 * The saved session with every question the set no longer holds taken out, saved back
 * when that changed anything. Sync prunes a single bank's session itself, but a pool's
 * session (under its `pool:` key) is only seen here. A session left with nothing to ask
 * is finished: it is deleted and null comes back.
 */
async function pruneSavedSession(store, key, session, questions) {
  const pruned = pruneSession(session, questions.map((q) => q.id));
  if (pruned.queue.length === 0) {
    await store.sessions.delete(key);
    return null;
  }
  const encoded = encodeState(pruned);
  if (JSON.stringify(encoded) !== JSON.stringify(encodeState(session))) await store.sessions.put(key, encoded);
  return pruned;
}

/** A copy of `bank` with every answer it has recorded erased. */
export function wipeAttempts(bank) {
  return {
    ...bank,
    questions: bank.questions.map((q) => ({ ...q, stats: { ...(q.stats ?? {}), attempts: [] } })),
  };
}

/**
 * Builds the set and the study model. `mode` is 'start' (no saved session), 'resume', or
 * 'fresh' (erase every answer in the bank, or in every pooled bank, and the saved session,
 * then start). Settings are saved first. Every change the model saves goes back through
 * the store in order; a write that fails is passed to `onSaveError`.
 *
 * Returns `{model, key, title, flush}`; `flush()` resolves once every queued write is done.
 */
export async function startStudy({
  store,
  paths,
  settings,
  mode = 'start',
  now = undefined,
  random = undefined,
  onSaveError = () => {},
}) {
  const setup = await loadSetup(store, paths);
  const chosen = effectiveSettings(setup.questions, decodeSettings(settings));
  const { key, title } = setup;
  await saveSettings(store, key, chosen);

  let banks = setup.banks;
  if (mode === 'fresh') {
    if (recordedAnswers(banks.flatMap((bank) => bank.questions)) > 0) {
      banks = banks.map(wipeAttempts);
      for (const bank of banks) await store.banks.put(bank);
    }
    await store.sessions.delete(key);
  }
  const resume = mode === 'resume' && setup.session !== null;
  const session = resume ? setup.session : null;

  let writes = Promise.resolve();
  const enqueue = (job) => {
    writes = writes.then(job).catch((error) => onSaveError(error));
  };
  const writeSession = async (state) => {
    if (state) await store.sessions.put(key, encodeState(state));
    else await store.sessions.delete(key);
  };

  let set;
  let persist;
  if (banks.length === 1) {
    let bank = banks[0];
    set = { ...bank, session };
    persist = (copy) => {
      bank = { ...bank, questions: copy.questions };
      const saved = bank;
      const state = copy.session ?? null;
      enqueue(async () => {
        await store.banks.put(saved);
        await writeSession(state);
      });
    };
  } else {
    const pool = buildPool(banks);
    let current = banks;
    set = { name: title, questions: pool.questions, session };
    persist = (copy) => {
      const changed = writeBack(pool, copy.questions, current);
      const byPath = new Map(changed.map((bank) => [bank.path, bank]));
      current = current.map((bank) => byPath.get(bank.path) ?? bank);
      const state = copy.session ?? null;
      enqueue(async () => {
        for (const bank of changed) await store.banks.put(bank);
        await writeSession(state);
      });
    };
  }

  const options = { set, settings: chosen, resume, persist, remove: () => {} };
  if (now) options.now = now;
  if (random) options.random = random;
  const model = createStudyModel(options);
  return { model, key, title, flush: () => writes };
}
