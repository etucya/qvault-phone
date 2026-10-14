// The app shell: opens the store, holds the screen state, wires sign-in and sync, and
// routes between screens. The library draws from the store straight away; sync runs after,
// so the app never waits on the network.

import { GOOGLE_CLIENT_ID } from './config.js';
import { openStore } from './store.js';
import { indexedDBAdapter } from './storeIndexedDB.js';
import { memoryAdapter } from './storeMemory.js';
import { createAuth } from './auth.js';
import { createDrive } from './drive.js';
import { syncLibrary, fetchPicture } from './sync.js';
import { planPrefetch, runPrefetch, PREFETCH_AT_ONCE } from './prefetch.js';
import { renderLibrary } from './ui/library.js';
import { renderSetup, newSetupState } from './ui/setup.js';
import { startStudy, loadSettings } from './ui/setupLogic.js';
import { forgetSession } from './ui/continueLogic.js';
import { renderStudy, stopStudy } from './ui/study.js';
import { el, banner, pillButton } from './ui/components.js';

const root = document.getElementById('app');

const state = {
  route: 'library',
  folder: '',
  selecting: false,
  selected: new Set(),
  syncing: false,
  error: null,
  warning: null,
  storageWarning: null, // the store fell back to memory: pinned for the whole run
  account: null,
  lastSync: null,
  banks: null, // the store's bank list, cached between renders; null means "read again"
  continueCard: null, // the library's Continue card ({title, remaining, tags, plan}), read with banks
  setup: null, // the setup sheet's own state while it is open (ui/setup.js)
  session: null, // {model, key, title, flush} once a study session has started
  saveError: null,
  prefetch: { remaining: 0 }, // background picture fetching, shown in the library's status line
  syncDue: false, // a re-sync held back while studying, run on the next return to the library
};

let store;
const auth = createAuth({ clientId: GOOGLE_CLIENT_ID });
const drive = createDrive({ fetch: (...args) => fetch(...args), getToken: () => auth.getToken() });

function describe(error) {
  if (error?.unauthorized) return 'Google needs you to sign in again (unauthorized). Studying still works from what is on this phone.';
  return error?.message || String(error);
}

// ---------------------------------------------------------------------------------------
// Screens

let prefetchAborted = false;
let prefetching = false;

async function render() {
  if (!store) return;
  try {
    if (state.route === 'study' && state.session) {
      // Studying has the phone's full attention; picture fetching stands down until the
      // next sync or launch.
      prefetchAborted = true;
      renderStudy(root, { store, drive, state, actions });
      return;
    }
    stopStudy();
    await renderLibrary(root, { store, state, actions });
    // The setup sheet sits over the library.
    if (state.route === 'setup' && state.setup) await renderSetup(root, { store, state, actions });
    if (state.route === 'library' && state.syncDue) {
      state.syncDue = false;
      syncIfSignedIn();
    }
  } catch (error) {
    console.error(error);
    state.error = `Could not show this screen: ${describe(error)}`;
    renderError();
  }
}

/** What is left on screen when drawing failed: the error, and a way back to the library. */
function renderError() {
  const screen = el('div', 'screen');
  const box = el('div', 'banners');
  if (state.storageWarning) box.append(banner({ message: state.storageWarning, tone: 'bad' }));
  box.append(banner({ message: state.error, tone: 'bad' }));
  const centre = el('div', 'centre');
  centre.append(
    pillButton({
      label: 'Back to library',
      style: 'primary',
      onTap: () => {
        // The session (if any) is in the store already; the library offers Resume.
        stopStudy();
        state.route = 'library';
        state.setup = null;
        state.session = null;
        state.banks = null;
        state.error = null;
        render();
      },
    }),
  );
  screen.append(box, centre);
  root.replaceChildren(screen);
}

// ---------------------------------------------------------------------------------------
// Actions

async function sync() {
  if (state.syncing) return false;
  if (!navigator.onLine) {
    state.error = "You're offline";
    render();
    return false;
  }
  state.syncing = true;
  state.error = null;
  let ok = false;
  render();
  try {
    const result = await syncLibrary({ drive, store });
    state.lastSync = await store.meta.get('lastSync');
    state.warning = result.failed.length
      ? `Could not read ${result.failed.map((f) => f.path).join(', ')}. The previous copy was kept.`
      : null;
    ok = true;
  } catch (error) {
    state.error = describe(error);
  } finally {
    state.syncing = false;
    state.account = auth.account();
    state.banks = null;
    render();
  }
  if (ok) schedulePrefetch();
  return ok;
}

// ---------------------------------------------------------------------------------------
// Picture prefetch: lowest priority, a few at a time, stops when a study session starts.

function showPrefetchProgress() {
  // Only the status line's text changes, so no full redraw per picture.
  const line = state.route === 'library' ? root.querySelector('.status-sync') : null;
  if (!line || state.syncing || state.prefetch.remaining <= 0) return;
  line.textContent = `Fetching pictures (${state.prefetch.remaining} left)`;
}

function schedulePrefetch() {
  setTimeout(() => {
    prefetchPictures().catch((error) => console.error(error));
  }, 0);
}

async function prefetchPictures() {
  if (prefetching || !store || !navigator.onLine) return;
  prefetching = true;
  prefetchAborted = state.route === 'study';
  let shown = false;
  try {
    const index = (await store.meta.get('mediaIndex')) ?? {};
    const banks = [];
    for (const { path } of await store.banks.list()) {
      const bank = await store.banks.get(path);
      if (bank) banks.push(bank);
    }
    // Names the library knows but Drive's media folder does not are not worth asking for.
    const cached = new Set();
    for (const bank of banks) {
      for (const { image } of bank.questions) {
        if (image && !cached.has(image) && (await store.pictures.has(image))) cached.add(image);
      }
    }
    const names = planPrefetch(banks, (name) => cached.has(name)).filter((name) => Object.hasOwn(index, name));
    if (names.length === 0 || prefetchAborted) return;
    state.prefetch = { remaining: names.length };
    shown = true;
    showPrefetchProgress();
    await runPrefetch({
      names,
      concurrency: PREFETCH_AT_ONCE,
      fetchOne: (name) => fetchPicture({ drive, store, name, mediaIndex: index }),
      shouldStop: () => prefetchAborted,
      onProgress: (remaining) => {
        state.prefetch = { remaining };
        showPrefetchProgress();
      },
    });
  } finally {
    prefetching = false;
    state.prefetch = { remaining: 0 };
    // Back to "Last sync" in the status line.
    if (shown && state.route === 'library' && !state.syncing) render();
  }
}

/**
 * The Sync button and pull-to-refresh. Without a token to be had (never signed in, or the
 * silent renewal failed), this signs in, which syncs after, rather than letting the sync
 * fail with a "not signed in" banner.
 */
async function syncNow() {
  if (state.syncing) return false;
  if (navigator.onLine && (await auth.getToken()) === null) {
    await signIn();
    return false;
  }
  return sync();
}

async function signIn() {
  try {
    await auth.signIn();
    state.account = auth.account();
    state.error = null;
  } catch (error) {
    state.error = `Sign-in failed: ${describe(error)}`;
    render();
    return;
  }
  render();
  await sync();
}

function goToSetup(paths) {
  state.setup = newSetupState(paths);
  state.selecting = false;
  state.selected = new Set();
  state.route = 'setup';
  render();
}

/**
 * The Continue card: straight back into the remembered session, no setup sheet. The same
 * startStudy Resume uses (pool rebuilt from the banks still here, session pruned to them),
 * under the remembered key and with the settings stored for it.
 */
let continuing = false;
async function continueSession(plan) {
  if (continuing) return;
  continuing = true;
  try {
    const settings = await loadSettings(store, plan.key);
    const session = await startStudy({
      store,
      paths: plan.paths,
      key: plan.key,
      settings,
      mode: 'resume',
      resumeOnly: true,
      onSaveError: (error) => {
        if (state.session) state.session.model.saveError = error;
        state.saveError = `Could not save your progress: ${error?.message || error}`;
        render();
      },
    });
    state.session = session;
    state.selecting = false;
    state.selected = new Set();
    state.banks = null;
    state.route = 'study';
  } catch (error) {
    // Finished since the card was drawn: the card just goes. Anything else is shown.
    if (error?.finished) await forgetSession(store, plan.key).catch(() => {});
    else state.error = `Could not continue: ${describe(error)}`;
    state.banks = null;
  } finally {
    continuing = false;
  }
  render();
}

const actions = {
  render,
  sync: syncNow,
  signIn,
  openBank: (path) => goToSetup([path]),
  studyBanks: (paths) => goToSetup(paths),
  continueSession,
};

// ---------------------------------------------------------------------------------------
// Launch

async function openPhoneStore() {
  try {
    return await openStore(await indexedDBAdapter());
  } catch (error) {
    state.storageWarning = `Could not open storage on this phone, so nothing will be kept: ${describe(error)}`;
    return openStore(memoryAdapter());
  }
}

/** Waits (briefly) for the Google sign-in script, which loads async alongside this one. */
function googleReady(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      if (globalThis.google?.accounts?.oauth2) resolve(true);
      else if (Date.now() - started > timeoutMs) resolve(false);
      else setTimeout(check, 100);
    };
    check();
  });
}

async function launch() {
  store = await openPhoneStore();
  state.account = auth.account();
  try {
    state.lastSync = await store.meta.get('lastSync');
  } catch {
    state.lastSync = null;
  }
  await render();
  // For debugging from the console (seeding a bank, inspecting state).
  globalThis.qvault = { store, state, render, actions };

  // A token comes back without a tap only for someone who signed in before (auth remembers
  // the consent across launches); otherwise getToken is null and the first-run panel waits
  // for the Sign in button.
  await syncIfSignedIn();
}

/** Syncs when online and a token is to be had; quietly does nothing otherwise. */
async function syncIfSignedIn() {
  if (!navigator.onLine || state.syncing) return;
  try {
    await googleReady();
    if ((await auth.getToken()) !== null) await sync();
  } catch (error) {
    console.error(error);
  }
}

// Coming back to the app after a while away: bring the library up to date. Not in the
// middle of studying, though (a sync rewrites banks under the open session); it waits for
// the next return to the library instead.
const RESYNC_AFTER_MS = 10 * 60 * 1000;
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
  hiddenAt = null;
  if (away <= RESYNC_AFTER_MS) return;
  if (state.route === 'study') state.syncDue = true;
  else syncIfSignedIn();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Without a worker the app still runs; it just will not open offline.
    });
  });
}

launch();
