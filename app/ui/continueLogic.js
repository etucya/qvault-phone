// The library's Continue card, without the DOM: the last session started or resumed is
// remembered in `meta` under 'lastSession' ({key, title, paths, startedAt}); the card shows
// while that session is still saved and at least one of its banks is still on the phone.
// Tapping it resumes through setupLogic.startStudy, the same path as the sheet's Resume.

import { bankName } from './library.js';
import { plural } from './components.js';

export const LAST_SESSION = 'lastSession';

/** Remembers the session under `key` as the one to continue. */
export async function rememberSession(store, { key, title, paths, startedAt = new Date() }) {
  await store.meta.put(LAST_SESSION, { key, title, paths: [...paths], startedAt: startedAt.toISOString() });
}

/** Forgets the remembered session, but only when it is the one under `key` (any, if omitted). */
export async function forgetSession(store, key = undefined) {
  if (key !== undefined) {
    const last = await store.meta.get(LAST_SESSION);
    if (!last || last.key !== key) return;
  }
  await store.meta.delete(LAST_SESSION);
}

/** The usable banks among `banks` (the library's list), keyed by path. */
function usable(banks) {
  return new Map((banks ?? []).filter((bank) => !bank.corrupt).map((bank) => [bank.path, bank]));
}

/**
 * What resuming the remembered session works from: its key, and those of its banks still
 * on the phone, in library order (the order `banks` comes in). Null when none remain.
 */
export function continuePlan({ lastSession, banks }) {
  if (!lastSession?.key || !Array.isArray(lastSession.paths)) return null;
  const wanted = new Set(lastSession.paths);
  const paths = [...usable(banks).keys()].filter((path) => wanted.has(path));
  if (paths.length === 0) return null;
  return { key: lastSession.key, paths };
}

/**
 * The card: `{title, remaining, tags}`, or null when there is nothing to continue (no
 * remembered session, its saved session is gone or has nothing left to ask, or none of its
 * banks remain). `session` is the stored (encoded) session; the tags are the ones it was
 * started with, else those of the stored `settings` for the key.
 */
export function continueCard({ lastSession, session, banks, settings = null }) {
  const plan = continuePlan({ lastSession, banks });
  if (!plan || !session) return null;
  const remaining = Array.isArray(session.queue) ? session.queue.length : 0;
  if (remaining === 0) return null;
  const byPath = usable(banks);
  const title = plan.paths.length === 1 ? bankName(byPath.get(plan.paths[0])) : plural(plan.paths.length, 'bank');
  const tags = [...(session.settings?.tags ?? settings?.tags ?? [])];
  return { title, remaining, tags };
}

/** "N to go", then the tag filter ("TQ only") when there is one. */
export function continueMeta({ remaining, tags }) {
  const parts = [`${remaining} to go`];
  if (tags.length > 0) parts.push(`${tags.join(', ')} only`);
  return parts.join(' · ');
}

/**
 * Reads what the card needs from the store for the library's `banks`: the card plus its
 * plan, or null. A remembered session none of whose banks remain is forgotten.
 */
export async function loadContinue(store, banks) {
  const lastSession = await store.meta.get(LAST_SESSION);
  if (!lastSession) return null;
  const plan = continuePlan({ lastSession, banks });
  if (!plan) {
    await forgetSession(store);
    return null;
  }
  let session = null;
  let settings = null;
  try {
    session = await store.sessions.get(plan.key);
    settings = await store.settings.get(plan.key);
  } catch {
    return null; // unreadable: no card
  }
  const card = continueCard({ lastSession, session, banks, settings });
  return card ? { ...card, plan } : null;
}
