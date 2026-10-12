import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrive } from '../app/drive.js';
import { mergeBank, pruneSession, syncLibrary, fetchPicture } from '../app/sync.js';
import { openStore } from '../app/store.js';
import { memoryAdapter } from '../app/storeMemory.js';
import { decodeSet } from '../app/engine/quiz.js';
import { encodeState } from '../app/engine/sessionEngine.js';
import { DEFAULT_SETTINGS } from '../app/engine/settings.js';
import { fakeDrive } from './fixtures/fakeDrive.js';

const at = (s) => new Date(s);

function question(id, extra = {}) {
  return {
    id,
    type: 'mcq',
    prompt: `Prompt ${id}`,
    options: [{ letter: 'A', text: 'yes' }, { letter: 'B', text: 'no' }],
    answer: 'A',
    keywords: [],
    tags: [],
    flagged: false,
    stats: { attempts: [], correct: 0, seen: 0 },
    ...extra,
  };
}

function quizText({ name = 'Bank', modified = '2026-10-01T10:00:00Z', questions, session } = {}) {
  const json = { created: '2026-09-01T10:00:00Z', modified, name, questions, schema: 1 };
  if (session) json.session = session;
  return JSON.stringify(json);
}

const macStats = { attempts: [{ at: '2026-09-02T14:36:12Z', ms: 900, outcome: 'wrong' }], correct: 0, seen: 1 };

function session(queue, extra = {}) {
  return {
    startedAt: at('2026-10-10T09:00:00Z'),
    settings: { ...DEFAULT_SETTINGS },
    queue,
    position: 0,
    retired: [],
    missed: [],
    streaks: {},
    availableAt: {},
    answered: 0,
    activeMs: 0,
    ...extra,
  };
}

async function setup() {
  const fake = fakeDrive({ pageSize: 2 });
  const lib = fake.folder('QVault', 'root', { id: 'lib' });
  const bio = fake.folder('Biology', lib, { id: 'bio' });
  fake.file('Blood.quiz', bio, quizText({ name: 'Blood', questions: [question('q1'), question('q2'), question('q3')] }), { id: 'blood', md5Checksum: 'b1' });
  fake.file('Top.quiz', lib, quizText({ name: 'Top', questions: [question('t1')] }), { id: 'top', md5Checksum: 't1' });
  const media = fake.folder('.media', lib, { id: 'media' });
  fake.file('abc.png', media, 'png-bytes', { id: 'img1' });
  const store = await openStore(memoryAdapter());
  const drive = createDrive({ fetch: fake.fetch, getToken: async () => 'tok' });
  return { fake, store, drive, lib, bio };
}

// mergeBank

test('mergeBank on a new bank takes everything from the file but the Mac stats, flags, notes and session', () => {
  const incoming = decodeSet(quizText({
    name: 'Blood',
    questions: [question('q1', { stats: macStats, flagged: true, note: 'mac note', tags: ['Blood'] })],
    session: encodeState(session(['q1'])),
  }));
  assert.ok(incoming.session, 'the file carries a Mac session');
  const bank = mergeBank(null, incoming, 'Biology/Blood.quiz', 'md5x');
  assert.equal(bank.path, 'Biology/Blood.quiz');
  assert.equal(bank.name, 'Blood');
  assert.equal(bank.md5, 'md5x');
  assert.equal(bank.modified, '2026-10-01T10:00:00Z');
  assert.equal(bank.session, undefined);
  assert.equal(bank.questions.length, 1);
  const [q] = bank.questions;
  assert.deepEqual(q.stats, { attempts: [] });
  assert.equal(q.flagged, false);
  assert.equal(q.note, undefined);
  assert.deepEqual(q.tags, ['Blood']);
  assert.equal(q.prompt, 'Prompt q1');
});

test('mergeBank keeps phone stats, flag and note by id, replaces the content, adds new and drops missing', () => {
  const phoneStats = { attempts: [{ at: at('2026-10-11T08:00:00Z'), outcome: 'correct', ms: 1200 }] };
  const existing = {
    path: 'Biology/Blood.quiz',
    name: 'Old name',
    md5: 'old',
    modified: '2026-09-01T10:00:00Z',
    questions: [
      { ...decodeSet(quizText({ questions: [question('q1')] })).questions[0], stats: phoneStats, flagged: true, note: 'phone note' },
      { ...decodeSet(quizText({ questions: [question('q2')] })).questions[0], stats: phoneStats },
      { ...decodeSet(quizText({ questions: [question('gone')] })).questions[0], stats: phoneStats, flagged: true },
    ],
  };
  const incoming = decodeSet(quizText({
    name: 'Blood (revised)',
    modified: '2026-10-11T20:00:00Z',
    questions: [
      question('q2', { prompt: 'New prompt q2', note: 'mac note', flagged: true, stats: macStats, explanation: 'why', image: 'abc.png' }),
      question('q1', { prompt: 'New prompt q1', answer: 'B', tags: ['Cells'] }),
      question('new'),
    ],
  }));
  const bank = mergeBank(existing, incoming, 'Biology/Blood.quiz', 'new-md5');
  assert.equal(bank.name, 'Blood (revised)');
  assert.equal(bank.md5, 'new-md5');
  assert.equal(bank.modified, '2026-10-11T20:00:00Z');
  assert.deepEqual(bank.questions.map((q) => q.id), ['q2', 'q1', 'new'], 'file order, missing ids dropped');

  const [q2, q1, fresh] = bank.questions;
  assert.equal(q1.prompt, 'New prompt q1');
  assert.equal(q1.answer, 'B');
  assert.deepEqual(q1.tags, ['Cells']);
  assert.deepEqual(q1.stats, phoneStats);
  assert.equal(q1.flagged, true);
  assert.equal(q1.note, 'phone note');

  assert.equal(q2.prompt, 'New prompt q2');
  assert.equal(q2.explanation, 'why');
  assert.equal(q2.image, 'abc.png');
  assert.deepEqual(q2.stats, phoneStats);
  assert.equal(q2.flagged, false, 'phone flag wins over the file');
  assert.equal(q2.note, undefined, 'phone has no note, the Mac note is ignored');

  assert.deepEqual(fresh.stats, { attempts: [] });
  assert.equal(fresh.flagged, false);
});

// pruneSession

test('pruneSession drops removed ids everywhere and keeps the rest', () => {
  const state = session(['a', 'gone', 'b', 'c'], {
    position: 1,
    retired: ['d', 'gone2'],
    missed: ['gone', 'a'],
    streaks: { a: 1, gone: 2, d: 1 },
    availableAt: { gone: at('2026-10-10T10:00:00Z'), b: at('2026-10-10T10:05:00Z') },
    answered: 5,
  });
  const pruned = pruneSession(state, ['a', 'b', 'c', 'd']);
  assert.deepEqual(pruned.queue, ['a', 'b', 'c']);
  assert.deepEqual(pruned.retired, ['d']);
  assert.deepEqual(pruned.missed, ['a']);
  assert.deepEqual(pruned.streaks, { a: 1, d: 1 });
  assert.deepEqual(Object.keys(pruned.availableAt), ['b']);
  assert.equal(pruned.position, 1);
  assert.equal(pruned.answered, 5);
  assert.deepEqual(state.queue, ['a', 'gone', 'b', 'c'], 'input untouched');
});

test('pruneSession sets the position to 0 when it falls past the end of the queue', () => {
  const pruned = pruneSession(session(['a', 'x', 'y'], { position: 2 }), new Set(['a']));
  assert.deepEqual(pruned.queue, ['a']);
  assert.equal(pruned.position, 0);
  const empty = pruneSession(session(['x'], { position: 0 }), []);
  assert.equal(empty.position, 0);
});

test('pruneSession moves the cursor back by the removed ids that sat before it', () => {
  const pruned = pruneSession(session(['a', 'x', 'b', 'y', 'c', 'd'], { position: 4 }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(pruned.queue, ['a', 'b', 'c', 'd']);
  assert.equal(pruned.position, 2, 'still on c');
  const after = pruneSession(session(['a', 'b', 'x', 'c'], { position: 1 }), ['a', 'b', 'c']);
  assert.equal(after.position, 1, 'removals after the cursor leave it alone');
  const atRemoved = pruneSession(session(['a', 'x', 'b'], { position: 1 }), ['a', 'b']);
  assert.equal(atRemoved.position, 1, 'the question now under the cursor is the next one, b');
});

// syncLibrary

test('first sync finds the folder, adds every bank, and records the folder, media index and time', async () => {
  const { fake, store, drive } = await setup();
  const result = await syncLibrary({ drive, store });
  assert.deepEqual(result, { added: 2, updated: 0, removed: 0, failed: [] });
  const list = await store.banks.list();
  assert.deepEqual(list.map((b) => [b.path, b.name, b.md5, b.questionCount]), [
    ['Biology/Blood.quiz', 'Blood', 'b1', 3],
    ['Top.quiz', 'Top', 't1', 1],
  ]);
  assert.equal(await store.meta.get('folderId'), 'lib');
  assert.deepEqual(await store.meta.get('mediaIndex'), { 'abc.png': 'img1' });
  assert.match(await store.meta.get('lastSync'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(fake.downloads(), 2);
});

test('a second sync with unchanged md5s downloads nothing and reuses the stored folder id', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  fake.calls.length = 0;
  const result = await syncLibrary({ drive, store });
  assert.deepEqual(result, { added: 0, updated: 0, removed: 0, failed: [] });
  assert.equal(fake.downloads(), 0);
  assert.ok(!fake.calls.some((c) => /name = 'QVault'/.test(c.url.searchParams.get('q') ?? '')), 'folder not searched again');
});

test('a changed bank is merged: phone stats, flag and note survive by id; removed questions and their session entries go', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  const bank = await store.banks.get('Biology/Blood.quiz');
  const attempt = { at: at('2026-10-11T08:00:00Z'), outcome: 'correct', ms: 800 };
  bank.questions[0] = { ...bank.questions[0], stats: { attempts: [attempt] }, flagged: true, note: 'mine' };
  await store.banks.put(bank);
  await store.sessions.put('Biology/Blood.quiz', session(['q3', 'q2', 'q1'], { position: 2, missed: ['q3'], streaks: { q3: 1 } }));

  fake.setContent('blood', quizText({ name: 'Blood', questions: [question('q1', { prompt: 'Edited' }), question('q2'), question('q4')] }), 'b2');
  const result = await syncLibrary({ drive, store });
  assert.deepEqual(result, { added: 0, updated: 1, removed: 0, failed: [] });
  assert.equal(fake.downloads(), 3, 'only the changed bank was downloaded again');

  const merged = await store.banks.get('Biology/Blood.quiz');
  assert.equal(merged.md5, 'b2');
  assert.deepEqual(merged.questions.map((q) => q.id), ['q1', 'q2', 'q4']);
  assert.equal(merged.questions[0].prompt, 'Edited');
  assert.deepEqual(merged.questions[0].stats.attempts.map((a) => a.ms), [800]);
  assert.equal(merged.questions[0].flagged, true);
  assert.equal(merged.questions[0].note, 'mine');

  const kept = await store.sessions.get('Biology/Blood.quiz');
  assert.deepEqual(kept.queue, ['q2', 'q1']);
  assert.deepEqual(kept.missed, []);
  assert.deepEqual(kept.streaks, {});
  assert.equal(kept.position, 1, 'q3 sat before the cursor, so it moves from 2 to 1 and still points at q1');
});

test('a bank gone from Drive is removed with its session and settings', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  await store.sessions.put('Top.quiz', session(['t1']));
  await store.settings.put('Top.quiz', { order: 'shuffle' });
  fake.remove('top');
  const result = await syncLibrary({ drive, store });
  assert.deepEqual(result, { added: 0, updated: 0, removed: 1, failed: [] });
  assert.equal(await store.banks.get('Top.quiz'), null);
  assert.equal(await store.sessions.get('Top.quiz'), null);
  assert.equal(await store.settings.get('Top.quiz'), null);
  assert.deepEqual((await store.banks.list()).map((b) => b.path), ['Biology/Blood.quiz']);
});

test('a bank that fails to parse keeps the old copy and is reported; others still sync', async () => {
  const { fake, store, drive, lib } = await setup();
  await syncLibrary({ drive, store });
  fake.setContent('blood', '{ not json', 'b-broken');
  fake.file('New.quiz', lib, quizText({ name: 'New', questions: [question('n1')] }), { id: 'new', md5Checksum: 'n1' });
  fake.file('Bad.quiz', lib, JSON.stringify({ name: 'Bad' }), { id: 'bad', md5Checksum: 'bad1' });
  const logged = [];
  const result = await syncLibrary({ drive, store, log: (m) => logged.push(m) });
  assert.equal(result.added, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.failed.map((f) => f.path).sort(), ['Bad.quiz', 'Biology/Blood.quiz']);
  assert.ok(result.failed.every((f) => typeof f.reason === 'string' && f.reason.length > 0));
  const old = await store.banks.get('Biology/Blood.quiz');
  assert.equal(old.md5, 'b1', 'old copy and its md5 kept, so the next sync tries again');
  assert.equal(old.questions.length, 3);
  assert.equal(await store.banks.get('Bad.quiz'), null);
  assert.ok(logged.length > 0);
});

test('a failed download is reported like a parse failure', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  fake.setContent('top', quizText({ name: 'Top', questions: [question('t1')] }), 't2');
  const original = fake.fetch;
  fake.fetch = async (input, init) => (String(input).includes('/files/top?') ? new Response('', { status: 500 }) : original(input, init));
  const flaky = createDrive({ fetch: (i, n) => fake.fetch(i, n), getToken: async () => 'tok' });
  const result = await syncLibrary({ drive: flaky, store });
  assert.deepEqual(result.failed.map((f) => f.path), ['Top.quiz']);
  assert.match(result.failed[0].reason, /500/);
  assert.equal((await store.banks.get('Top.quiz')).md5, 't1');
});

test('sync throws a message naming the folder when it is not on Drive', async () => {
  const fake = fakeDrive();
  const store = await openStore(memoryAdapter());
  const drive = createDrive({ fetch: fake.fetch, getToken: async () => 'tok' });
  await assert.rejects(syncLibrary({ drive, store }), /QVault/);
});

test('sync leaves the library alone when Drive refuses the token', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  fake.failWith(401);
  await assert.rejects(syncLibrary({ drive, store }), /unauthorized/);
  assert.equal((await store.banks.list()).length, 2);
});

test('a stored folder id that now lists nothing is checked by name before anything is removed', async () => {
  const { store, drive } = await setup();
  await syncLibrary({ drive, store });
  await store.meta.put('folderId', 'stale');
  const result = await syncLibrary({ drive, store });
  assert.deepEqual(result, { added: 0, updated: 0, removed: 0, failed: [] });
  assert.equal(await store.meta.get('folderId'), 'lib');
  assert.equal((await store.banks.list()).length, 2);
});

test('a stored folder id that Drive no longer knows (404) is looked up again by name', async () => {
  const fake = fakeDrive();
  const lib = fake.folder('QVault', 'root', { id: 'lib' });
  fake.file('A.quiz', lib, quizText({ name: 'A', questions: [question('a1')] }), { id: 'a', md5Checksum: 'a1' });
  const drive = createDrive({
    fetch: async (input, init) => (String(input).includes('%27gone%27') ? new Response('', { status: 404 }) : fake.fetch(input, init)),
    getToken: async () => 'tok',
  });
  const store = await openStore(memoryAdapter());
  await store.meta.put('folderId', 'gone');
  const result = await syncLibrary({ drive, store });
  assert.equal(result.added, 1);
  assert.equal(await store.meta.get('folderId'), 'lib');
});

// fetchPicture

test('fetchPicture downloads through the stored media index once, then serves the cache', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  const before = fake.downloads();
  const blob = await fetchPicture({ drive, store, name: 'abc.png' });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
  assert.equal(await blob.text(), 'png-bytes');
  assert.equal(await store.pictures.has('abc.png'), true);
  const again = await fetchPicture({ drive, store, name: 'abc.png' });
  assert.equal(await again.text(), 'png-bytes');
  assert.equal(fake.downloads(), before + 1);
});

test('fetchPicture returns null for an unknown name or a failed download, and never throws', async () => {
  const { fake, store, drive } = await setup();
  assert.equal(await fetchPicture({ drive, store, name: 'abc.png' }), null, 'no media index yet');
  await syncLibrary({ drive, store });
  assert.equal(await fetchPicture({ drive, store, name: 'missing.png' }), null);
  fake.failWith(500);
  assert.equal(await fetchPicture({ drive, store, name: 'abc.png' }), null);
  assert.equal(await store.pictures.has('abc.png'), false, 'nothing cached, so it is retried next time');
});

test('a listing that fails partway through leaves every stored bank untouched', async () => {
  const { fake, store, drive } = await setup();
  await syncLibrary({ drive, store });
  const before = await store.banks.list();
  const blood = await store.banks.get('Biology/Blood.quiz');
  const lastSync = await store.meta.get('lastSync');

  // The bank on Drive changed, so a clean sync would rewrite it; break the listing instead.
  fake.setContent('blood', quizText({ name: 'Blood', questions: [question('q9')] }), 'b2');
  fake.calls.length = 0;
  fake.failAfter(2);
  await assert.rejects(syncLibrary({ drive, store }), /503/);
  assert.ok(fake.calls.length >= 3, 'the failure came after some requests succeeded');

  assert.deepEqual(await store.banks.list(), before);
  assert.deepEqual(await store.banks.get('Biology/Blood.quiz'), blood);
  assert.equal(await store.meta.get('lastSync'), lastSync);
});
