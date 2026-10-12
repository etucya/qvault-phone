// The app shell: opens the store, holds the screen state, wires sign-in and sync, and
// routes between screens. The library draws from the store straight away; sync runs after,
// so the app never waits on the network.

import { GOOGLE_CLIENT_ID } from './config.js';
import { openStore } from './store.js';
import { indexedDBAdapter } from './storeIndexedDB.js';
import { memoryAdapter } from './storeMemory.js';
import { createAuth } from './auth.js';
import { createDrive } from './drive.js';
import { syncLibrary } from './sync.js';
import { renderLibrary } from './ui/library.js';
import { renderSetup, newSetupState } from './ui/setup.js';
import { el, pillButton, banner } from './ui/components.js';

const root = document.getElementById('app');

const state = {
  route: 'library',
  folder: '',
  selecting: false,
  selected: new Set(),
  syncing: false,
  error: null,
  warning: null,
  account: null,
  lastSync: null,
  banks: null, // the store's bank list, cached between renders; null means "read again"
  setup: null, // the setup sheet's own state while it is open (ui/setup.js)
  session: null, // {model, key, title, flush} once a study session has started
  saveError: null,
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

// Task 10 replaces this with the study screen.
function renderStudyPlaceholder() {
  const { model, title } = state.session;
  const screen = el('div', 'screen');
  const bar = el('header', 'topbar');
  bar.append(el('h1', 'title', title));
  const banners = el('div', 'banners');
  if (state.saveError) banners.append(banner({ message: state.saveError }));
  const centre = el('div', 'centre');
  const panel = el('div', 'panel hero');
  const current = model.current;
  panel.append(
    el('p', 'hero-text', 'Study — coming next'),
    el('p', 'study-prompt', current ? current.prompt : 'Nothing left to study in this session.'),
    pillButton({
      label: 'Back to library',
      style: 'secondary',
      onTap: () => {
        // The session stays saved, so the bank offers Resume next time.
        state.route = 'library';
        state.banks = null;
        render();
      },
    }),
  );
  centre.append(panel);
  screen.append(bar, banners, centre);
  root.replaceChildren(screen);
}

async function render() {
  if (!store) return;
  try {
    if (state.route === 'study' && state.session) {
      renderStudyPlaceholder();
      return;
    }
    await renderLibrary(root, { store, state, actions });
    // The setup sheet sits over the library.
    if (state.route === 'setup' && state.setup) await renderSetup(root, { store, state, actions });
  } catch (error) {
    console.error(error);
    state.error = `Could not show the library: ${describe(error)}`;
  }
}

// ---------------------------------------------------------------------------------------
// Actions

async function sync() {
  if (state.syncing) return;
  if (!navigator.onLine) {
    state.error = "You're offline";
    render();
    return;
  }
  state.syncing = true;
  state.error = null;
  render();
  try {
    const result = await syncLibrary({ drive, store });
    state.lastSync = await store.meta.get('lastSync');
    state.warning = result.failed.length
      ? `Could not read ${result.failed.map((f) => f.path).join(', ')}. The previous copy was kept.`
      : null;
  } catch (error) {
    state.error = describe(error);
  } finally {
    state.syncing = false;
    state.account = auth.account();
    state.banks = null;
    render();
  }
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

const actions = {
  render,
  sync,
  signIn,
  openBank: (path) => goToSetup([path]),
  studyBanks: (paths) => goToSetup(paths),
};

// ---------------------------------------------------------------------------------------
// Launch

async function openPhoneStore() {
  try {
    return await openStore(await indexedDBAdapter());
  } catch (error) {
    state.error = `Could not open storage on this phone, so nothing will be kept: ${describe(error)}`;
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

  // A token comes back without a tap only for someone who signed in before; otherwise
  // getToken is null and the first-run panel waits for the Sign in button.
  if (!navigator.onLine) return;
  await googleReady();
  if ((await auth.getToken()) !== null) await sync();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Without a worker the app still runs; it just will not open offline.
    });
  });
}

launch();
