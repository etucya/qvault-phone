import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderOf, folderView, existingFolder, crumbs, bankName, loadLibrary } from '../app/ui/library.js';
import { openStore } from '../app/store.js';
import { memoryAdapter } from '../app/storeMemory.js';

const b = (path, extra = {}) => ({ path, name: path.split('/').pop().replace('.quiz', ''), ...extra });
const library = [
  b('Top.quiz'),
  b('Biology/Blood.quiz'),
  b('Biology/Cells/Membranes.quiz'),
  b('Biology/Cells/Organelles.quiz'),
  b('Biology/Genetics/DNA.quiz'),
  b('chemistry/Acids.quiz'),
];

test('folderOf gives the parent folder path', () => {
  assert.equal(folderOf('Top.quiz'), '');
  assert.equal(folderOf('Biology/Cells/Membranes.quiz'), 'Biology/Cells');
});

test('the root shows its folders, each counting every bank inside, and its own banks', () => {
  const view = folderView(library, '');
  assert.deepEqual(view.folders, [
    { name: 'Biology', path: 'Biology', count: 4 },
    { name: 'chemistry', path: 'chemistry', count: 1 },
  ]);
  assert.deepEqual(view.banks.map((x) => x.path), ['Top.quiz']);
});

test('a folder shows one level down only', () => {
  const view = folderView(library, 'Biology');
  assert.deepEqual(view.folders.map((f) => [f.path, f.count]), [['Biology/Cells', 2], ['Biology/Genetics', 1]]);
  assert.deepEqual(view.banks.map((x) => x.path), ['Biology/Blood.quiz']);
  assert.deepEqual(folderView(library, 'Biology/Cells').folders, []);
});

test('a folder name that prefixes another is not confused with it', () => {
  const view = folderView([b('Bio/A.quiz'), b('Biology/B.quiz')], 'Bio');
  assert.deepEqual(view.banks.map((x) => x.path), ['Bio/A.quiz']);
  assert.deepEqual(view.folders, []);
});

test('a folder emptied by a sync falls back to the nearest folder that still has banks', () => {
  assert.equal(existingFolder(library, 'Biology/Cells'), 'Biology/Cells');
  assert.equal(existingFolder(library, 'Biology/Gone/Deeper'), 'Biology');
  assert.equal(existingFolder(library, 'Physics'), '');
  assert.equal(existingFolder([], 'Biology'), '');
});

test('breadcrumbs start at Library', () => {
  assert.deepEqual(crumbs(''), [{ label: 'Library', folder: '' }]);
  assert.deepEqual(crumbs('Biology/Cells'), [
    { label: 'Library', folder: '' },
    { label: 'Biology', folder: 'Biology' },
    { label: 'Cells', folder: 'Biology/Cells' },
  ]);
});

test('a bank without a name shows its file name', () => {
  assert.equal(bankName({ path: 'A/Some Bank.quiz', name: 'Proper' }), 'Proper');
  assert.equal(bankName({ path: 'A/Some Bank.quiz' }), 'Some Bank');
});

test('loadLibrary adds session progress to banks that have a session', async () => {
  const store = await openStore(memoryAdapter());
  const questions = [{ id: 'q1', stats: { attempts: [] } }, { id: 'q2', stats: { attempts: [] } }];
  await store.banks.put({ path: 'A.quiz', name: 'A', md5: 'x', questions });
  await store.banks.put({ path: 'B.quiz', name: 'B', md5: 'y', questions });
  await store.sessions.put('A.quiz', { queue: ['q2', 'q3', 'q4'], retired: ['q1'], position: 0 });
  const banks = await loadLibrary(store);
  assert.deepEqual(banks.find((x) => x.path === 'A.quiz').session, { cleared: 1, total: 4 });
  assert.equal(banks.find((x) => x.path === 'B.quiz').session, undefined);
});
