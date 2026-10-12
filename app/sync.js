// Brings the phone's library in line with the QVault folder on Drive (design "Sync rules").
// Only banks whose md5 changed are downloaded. The phone's own progress (stats, flagged,
// note) is kept by question id; everything else comes from the file. Nothing is written
// to Drive.

import { LIBRARY_FOLDER } from './config.js';
import { decodeSet } from './engine/quiz.js';
import { isoSeconds } from './engine/dates.js';

const DOWNLOADS_AT_ONCE = 4;

const PICTURE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
};

/** The phone's copy of a bank after reading `incoming` (a decoded .quiz) from Drive. */
export function mergeBank(existing, incoming, path, md5) {
  const phone = new Map((existing?.questions ?? []).map((q) => [q.id, q]));
  const questions = incoming.questions.map((fromFile) => {
    const { stats, flagged, note, ...content } = fromFile;
    const mine = phone.get(fromFile.id);
    const question = {
      ...content,
      flagged: mine?.flagged === true,
      stats: mine?.stats ?? { attempts: [] },
    };
    if (mine?.note !== undefined && mine?.note !== null) question.note = mine.note;
    return question;
  });
  const bank = {
    path,
    name: incoming.name,
    md5,
    modified: isoSeconds(incoming.modified),
    created: isoSeconds(incoming.created),
    schema: incoming.schema,
    questions,
  };
  if (incoming.source !== undefined) bank.source = incoming.source;
  return bank;
}

/** A copy of a session with every question id outside `questionIds` taken out. */
export function pruneSession(state, questionIds) {
  const keep = questionIds instanceof Set ? questionIds : new Set(questionIds);
  const list = (ids) => (ids ?? []).filter((id) => keep.has(id));
  const map = (object) => Object.fromEntries(Object.entries(object ?? {}).filter(([id]) => keep.has(id)));
  const queue = list(state.queue);
  return {
    ...state,
    queue,
    retired: list(state.retired),
    missed: list(state.missed),
    streaks: map(state.streaks),
    availableAt: map(state.availableAt),
    position: state.position >= 0 && state.position < queue.length ? state.position : 0,
  };
}

async function inBatches(items, size, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

async function locateFolder(drive, store, log) {
  log(`Looking for the ${LIBRARY_FOLDER} folder`);
  const id = await drive.findFolder(LIBRARY_FOLDER);
  if (!id) throw new Error(`No folder named "${LIBRARY_FOLDER}" in My Drive`);
  await store.meta.put('folderId', id);
  return id;
}

/** Lists the library, re-finding the folder by name when the stored id has gone stale. */
async function listLibrary(drive, store, log, hadBanks) {
  const cached = await store.meta.get('folderId');
  if (!cached) return drive.listTree(await locateFolder(drive, store, log));
  let tree;
  try {
    tree = await drive.listTree(cached);
  } catch (error) {
    if (error.status !== 404) throw error;
    return drive.listTree(await locateFolder(drive, store, log));
  }
  // An empty listing would delete the whole library; make sure it really is the folder.
  if (tree.banks.length === 0 && hadBanks) {
    const id = await locateFolder(drive, store, log);
    if (id !== cached) return drive.listTree(id);
  }
  return tree;
}

/** Syncs the library from Drive into the store. Throws only when the folder cannot be listed. */
export async function syncLibrary({ drive, store, log = () => {}, now = () => new Date() }) {
  const stored = await store.banks.list();
  const { banks, mediaIndex } = await listLibrary(drive, store, log, stored.length > 0);
  const storedMd5 = new Map(stored.map((b) => [b.path, b.md5]));
  const result = { added: 0, updated: 0, removed: 0, failed: [] };

  const changed = banks.filter((b) => storedMd5.get(b.path) !== b.md5Checksum);
  log(`${banks.length} banks on Drive, ${changed.length} to download`);
  const decoder = new TextDecoder('utf-8');
  await inBatches(changed, DOWNLOADS_AT_ONCE, async (file) => {
    let incoming;
    try {
      incoming = decodeSet(decoder.decode(await drive.download(file.id)));
    } catch (error) {
      log(`Could not read ${file.path}: ${error.message}`);
      result.failed.push({ path: file.path, reason: error.message || String(error) });
      return;
    }
    const existing = await store.banks.get(file.path);
    const bank = mergeBank(existing, incoming, file.path, file.md5Checksum);
    await store.banks.put(bank);
    if (existing) {
      result.updated += 1;
      const session = await store.sessions.get(file.path);
      if (session) await store.sessions.put(file.path, pruneSession(session, bank.questions.map((q) => q.id)));
    } else {
      result.added += 1;
    }
    log(`${existing ? 'Updated' : 'Added'} ${file.path}`);
  });

  const onDrive = new Set(banks.map((b) => b.path));
  for (const { path } of stored) {
    if (onDrive.has(path)) continue;
    await store.banks.delete(path);
    result.removed += 1;
    log(`Removed ${path}`);
  }

  await store.meta.put('mediaIndex', Object.fromEntries(mediaIndex));
  await store.meta.put('lastSync', isoSeconds(now()));
  return result;
}

function pictureType(name) {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return PICTURE_TYPES[extension] ?? 'application/octet-stream';
}

/** A picture from the cache, or from Drive (then cached). Null when unknown or unreachable. */
export async function fetchPicture({ drive, store, name, mediaIndex = null }) {
  try {
    const cached = await store.pictures.get(name);
    if (cached) return cached;
    const index = mediaIndex ?? (await store.meta.get('mediaIndex'));
    const id = index instanceof Map ? index.get(name) : index && Object.hasOwn(index, name) ? index[name] : null;
    if (!id) return null;
    const blob = new Blob([await drive.download(id)], { type: pictureType(name) });
    await store.pictures.put(name, blob);
    return blob;
  } catch {
    return null;
  }
}
