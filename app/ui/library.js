// The library screen: the Drive folder tree one level at a time, bank rows with their
// mastery, long-press selection for pooled study, the sync status line, and the first-run
// sign-in panel.
//
// renderLibrary(root, {store, state, actions}) redraws the whole screen. Screen-local state
// (state.folder, state.selecting, state.selected) is changed here and followed by
// actions.render(); everything else goes through the other actions (openBank, studyBanks,
// sync, signIn). state.banks caches the bank list; set it to null to make the next render
// read the store again.

import { LIBRARY_FOLDER } from '../config.js';
import { el, pillButton, masteryRing, banner, qMark, relativeDate, plural } from './components.js';

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
const PULL_TRIGGER_PX = 80;

// ---------------------------------------------------------------------------------------
// The tree, derived from bank paths ("Biology/Cells/Membranes.quiz"). Pure, so testable.

/** The folder a bank lives in: '' at the root, else its path segments joined with "/". */
export function folderOf(path) {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** What one level shows: subfolders (with the number of banks anywhere inside) and banks. */
export function folderView(banks, folder) {
  const prefix = folder === '' ? '' : `${folder}/`;
  const counts = new Map();
  const here = [];
  for (const bank of banks) {
    const home = folderOf(bank.path);
    if (home === folder) {
      here.push(bank);
    } else if (home.startsWith(prefix)) {
      const name = home.slice(prefix.length).split('/')[0];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const folders = [...counts.keys()].sort(byName).map((name) => ({ name, path: prefix + name, count: counts.get(name) }));
  return { folders, banks: here };
}

/** The deepest folder at or above `folder` that still holds a bank ('' when none do). */
export function existingFolder(banks, folder) {
  let current = folder;
  while (current !== '') {
    const prefix = `${current}/`;
    if (banks.some((b) => folderOf(b.path) === current || b.path.startsWith(prefix))) return current;
    const cut = current.lastIndexOf('/');
    current = cut === -1 ? '' : current.slice(0, cut);
  }
  return '';
}

/** Breadcrumbs from the root: [{label:'Library', folder:''}, {label:'Biology', folder:'Biology'}, …]. */
export function crumbs(folder) {
  const out = [{ label: 'Library', folder: '' }];
  if (folder === '') return out;
  const parts = folder.split('/');
  parts.forEach((label, i) => out.push({ label, folder: parts.slice(0, i + 1).join('/') }));
  return out;
}

/** A bank's display name: its own name, else the file name without ".quiz". */
export function bankName(bank) {
  if (bank.name) return bank.name;
  const file = bank.path.slice(bank.path.lastIndexOf('/') + 1);
  return file.replace(/\.quiz$/i, '');
}

/** The store's bank list, each with its session progress ({cleared, total}) when one exists. */
export async function loadLibrary(store) {
  const banks = await store.banks.list();
  await Promise.all(
    banks
      .filter((b) => b.hasSession && !b.corrupt)
      .map(async (bank) => {
        try {
          const session = await store.sessions.get(bank.path);
          const cleared = session?.retired?.length ?? 0;
          const total = cleared + (session?.queue?.length ?? 0);
          if (total > 0) bank.session = { cleared, total };
        } catch {
          // A session that cannot be read just shows no bar.
        }
      }),
  );
  return banks;
}

// ---------------------------------------------------------------------------------------
// Small pieces

const SVG = 'http://www.w3.org/2000/svg';

function icon(paths, className) {
  const node = document.createElementNS(SVG, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('class', `icon ${className}`);
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    node.append(path);
  }
  return node;
}

const folderIcon = () => icon(['M3 7.5a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'], 'icon-folder');
const chevron = () => icon(['M9 5l7 7-7 7'], 'icon-chevron');

function checkmark(on) {
  const box = el('span', on ? 'check check-on' : 'check');
  if (on) box.append(icon(['M6 12.5l4 4 8-9'], 'icon-check'));
  return box;
}

// A long press (500 ms without moving more than 10px) swallows the click that ends it. The
// flag lives at module level because the press re-renders the screen, so that click lands
// on a fresh row.
let swallowClick = false;

function pressable(node, { onTap, onLongPress = null }) {
  let timer = null;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  node.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    swallowClick = false;
    start = { x: event.clientX, y: event.clientY };
    cancel();
    if (onLongPress) {
      timer = setTimeout(() => {
        timer = null;
        swallowClick = true;
        onLongPress();
      }, LONG_PRESS_MS);
    }
  });
  node.addEventListener('pointermove', (event) => {
    if (timer && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(type, cancel);
  node.addEventListener('contextmenu', (event) => event.preventDefault());
  node.addEventListener('click', (event) => {
    if (swallowClick) {
      swallowClick = false;
      event.preventDefault();
      return;
    }
    onTap(event);
  });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onTap(event);
    }
  });
}

function row(className) {
  const node = el('div', `row ${className}`);
  node.setAttribute('role', 'button');
  node.tabIndex = 0;
  return node;
}

// ---------------------------------------------------------------------------------------
// Rows

function folderRow(folder, { state, actions }) {
  const node = row('row-folder');
  const main = el('div', 'row-main');
  main.append(el('div', 'row-name', folder.name), el('div', 'row-meta', plural(folder.count, 'bank')));
  node.append(folderIcon(), main, chevron());
  node.setAttribute('aria-label', `${folder.name}, ${plural(folder.count, 'bank')}`);
  pressable(node, {
    onTap: () => {
      state.folder = folder.path;
      actions.render();
    },
  });
  return node;
}

function sessionBar(session) {
  const wrap = el('div', 'session');
  const track = el('div', 'session-track');
  const fill = el('div', 'session-fill');
  fill.style.width = `${(session.cleared / session.total) * 100}%`;
  track.append(fill);
  wrap.append(track, el('div', 'session-text', `${session.cleared} of ${session.total} this session`));
  return wrap;
}

function bankRow(bank, { state, actions }) {
  const name = bankName(bank);
  if (bank.corrupt) {
    const node = el('div', 'row row-bank row-corrupt');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-name', name), el('div', 'row-meta', 'Could not read this bank'));
    node.append(main, masteryRing(null));
    return node;
  }

  const selected = state.selected.has(bank.path);
  const node = row(`row-bank${state.selecting && selected ? ' row-selected' : ''}`);
  if (state.selecting) node.append(checkmark(selected));

  const main = el('div', 'row-main');
  const studied = bank.lastStudied ? relativeDate(bank.lastStudied) : 'never studied';
  const meta = el('div', 'row-meta');
  meta.append(el('span', '', `${plural(bank.questionCount, 'question')} · ${studied}`));
  if (!bank.lastStudied && bank.questionCount > 0) meta.append(el('span', 'tag-new', 'New'));
  main.append(el('div', 'row-name', name), meta);
  if (bank.hasSession && bank.session) main.append(sessionBar(bank.session));

  node.append(main, masteryRing(bank.lastStudied ? bank.mastery : null));
  node.setAttribute('aria-label', `${name}, ${plural(bank.questionCount, 'question')}, ${studied}`);
  if (state.selecting) node.setAttribute('aria-pressed', String(selected));

  const toggle = () => {
    if (state.selected.has(bank.path)) state.selected.delete(bank.path);
    else state.selected.add(bank.path);
    actions.render();
  };
  pressable(node, {
    onTap: () => (state.selecting ? toggle() : actions.openBank(bank.path)),
    onLongPress: () => {
      if (!state.selecting) {
        state.selecting = true;
        state.selected = new Set();
      }
      state.selected.add(bank.path);
      actions.render();
    },
  });
  return node;
}

// ---------------------------------------------------------------------------------------
// Screen parts

function topBar(folder, { state, actions }) {
  const bar = el('header', 'topbar');
  const trail = crumbs(folder);
  if (trail.length > 1) {
    const nav = el('nav', 'crumbs');
    nav.setAttribute('aria-label', 'Folders');
    trail.slice(0, -1).forEach((crumb, i) => {
      if (i > 0) nav.append(el('span', 'crumb-sep', '›'));
      const button = el('button', 'crumb', crumb.label);
      button.type = 'button';
      button.addEventListener('click', () => {
        state.folder = crumb.folder;
        actions.render();
      });
      nav.append(button);
    });
    bar.append(nav);
  }
  bar.append(el('h1', 'title', trail[trail.length - 1].label));
  return bar;
}

function banners({ state, actions }) {
  const box = el('div', 'banners');
  if (state.error) {
    const needsSignIn = /unauthori[sz]ed/i.test(state.error);
    box.append(
      banner({
        message: state.error,
        tone: 'bad',
        action: needsSignIn ? { label: 'Sign in', onTap: () => actions.signIn() } : null,
      }),
    );
  }
  if (state.warning) box.append(banner({ message: state.warning, tone: 'warn' }));
  return box;
}

function statusLine({ state, actions }) {
  const bar = el('footer', 'statusbar');
  const text = el('div', 'status-text');
  text.append(el('div', 'status-account', state.account || 'Not signed in'));
  const when = state.syncing
    ? 'Syncing…'
    : state.lastSync
      ? `Last sync: ${relativeDate(state.lastSync)}`
      : 'Never synced';
  const sync = el('div', 'status-sync', when);
  sync.setAttribute('aria-live', 'polite');
  text.append(sync);
  bar.append(text, pillButton({ label: 'Sync', style: 'secondary', disabled: state.syncing, onTap: () => actions.sync() }));
  return bar;
}

function selectionBar({ state, actions }) {
  const bar = el('footer', 'statusbar selectbar');
  const count = state.selected.size;
  bar.append(
    pillButton({
      label: 'Cancel',
      style: 'ghost',
      onTap: () => {
        state.selecting = false;
        state.selected = new Set();
        actions.render();
      },
    }),
    pillButton({
      label: `Study ${plural(count, 'bank')}`,
      style: 'primary',
      disabled: count === 0,
      onTap: () => actions.studyBanks(selectedInOrder(state)),
    }),
  );
  return bar;
}

/** The selection in library order (the store's path order), not tap order. */
function selectedInOrder(state) {
  return (state.banks ?? []).map((b) => b.path).filter((path) => state.selected.has(path));
}

function centredPanel(...children) {
  const wrap = el('div', 'centre');
  const panel = el('div', 'panel hero');
  panel.append(...children);
  wrap.append(panel);
  return wrap;
}

function firstRun({ actions }) {
  return centredPanel(
    qMark(88),
    el('p', 'hero-text', 'Sign in with Google to pull your question banks from Drive.'),
    pillButton({ label: 'Sign in', style: 'primary', onTap: () => actions.signIn() }),
  );
}

function emptyLibrary({ state, actions }) {
  return centredPanel(
    qMark(64),
    el('p', 'hero-text', `No question banks yet. Put .quiz files in the ${LIBRARY_FOLDER} folder on Google Drive, then sync.`),
    pillButton({ label: state.syncing ? 'Syncing…' : 'Sync', style: 'primary', disabled: state.syncing, onTap: () => actions.sync() }),
  );
}

function pullToRefresh(scroll, indicator, { state, actions }) {
  let startY = null;
  let pulled = 0;
  const reset = () => {
    startY = null;
    pulled = 0;
    indicator.style.height = '0px';
    indicator.classList.remove('pull-ready');
  };
  scroll.addEventListener(
    'touchstart',
    (event) => {
      const ok = scroll.scrollTop <= 0 && !state.syncing && !state.selecting && event.touches.length === 1;
      startY = ok ? event.touches[0].clientY : null;
      pulled = 0;
    },
    { passive: true },
  );
  scroll.addEventListener(
    'touchmove',
    (event) => {
      if (startY === null) return;
      pulled = event.touches[0].clientY - startY;
      if (pulled <= 0 || scroll.scrollTop > 0) {
        indicator.style.height = '0px';
        return;
      }
      const ready = pulled > PULL_TRIGGER_PX;
      indicator.style.height = `${Math.min(pulled / 2, 64)}px`;
      indicator.classList.toggle('pull-ready', ready);
      indicator.firstChild.textContent = ready ? 'Release to sync' : 'Pull to sync';
    },
    { passive: true },
  );
  scroll.addEventListener('touchend', () => {
    const go = startY !== null && pulled > PULL_TRIGGER_PX;
    reset();
    if (go) actions.sync();
  });
  scroll.addEventListener('touchcancel', reset);
}

// ---------------------------------------------------------------------------------------

let renderSeq = 0;

export async function renderLibrary(root, { store, state, actions }) {
  const seq = (renderSeq += 1);
  if (!state.banks) {
    const banks = await loadLibrary(store);
    if (seq !== renderSeq) return; // a newer render took over
    state.banks = banks;
  }
  const banks = state.banks;

  // Keep the scroll position when redrawing the same folder (a selection toggle, say).
  const previous = root.querySelector('.scroll');
  const keepScroll = previous && previous.dataset.folder === state.folder ? previous.scrollTop : 0;

  const screen = el('div', 'screen library');
  const context = { state, actions };

  if (banks.length === 0 && !state.account) {
    screen.append(banners(context), firstRun(context));
    root.replaceChildren(screen);
    return;
  }

  state.folder = existingFolder(banks, state.folder);
  if (state.selecting) {
    // Drop anything that vanished in a sync.
    const known = new Set(banks.map((b) => b.path));
    for (const path of state.selected) if (!known.has(path)) state.selected.delete(path);
  }

  const scroll = el('div', 'scroll');
  scroll.dataset.folder = state.folder;
  const indicator = el('div', 'pull');
  indicator.append(el('span', '', 'Pull to sync'));
  scroll.append(indicator);

  if (banks.length === 0) {
    scroll.append(emptyLibrary(context));
  } else {
    const view = folderView(banks, state.folder);
    const list = el('div', 'list');
    list.setAttribute('role', 'list');
    for (const folder of view.folders) list.append(folderRow(folder, context));
    for (const bank of view.banks) list.append(bankRow(bank, context));
    scroll.append(list);
  }
  pullToRefresh(scroll, indicator, context);

  screen.append(topBar(state.folder, context), banners(context), scroll, state.selecting ? selectionBar(context) : statusLine(context));
  root.replaceChildren(screen);
  if (keepScroll) scroll.scrollTop = keepScroll;
}
