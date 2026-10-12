import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../app/store.js';
import { memoryAdapter } from '../app/storeMemory.js';
import { indexedDBAdapter } from '../app/storeIndexedDB.js';

let dbCounter = 0;
const adapters = {
  memory: async () => memoryAdapter(),
  indexedDB: async () => indexedDBAdapter(`qvault-test-${dbCounter++}`),
};

const attempt = (at, outcome = 'correct') => ({ at: new Date(at), outcome, ms: 1000 });
const question = (id, attempts = []) => ({ id, text: `Q${id}`, stats: { attempts } });
const bank = (path, questions, extra = {}) => ({
  path,
  name: path.split('/').pop().replace(/\.quiz$/, ''),
  md5: `md5-${path}`,
  modified: '2026-09-02T14:36:12Z',
  questions,
  ...extra,
});

for (const [adapterName, makeAdapter] of Object.entries(adapters)) {
  const t = (name, fn) =>
    test(`${adapterName}: ${name}`, async () => fn(await openStore(await makeAdapter())));

  t('bank round trip keeps the record and dates', async (store) => {
    const b = bank('Bio/Cells.quiz', [question('a', [attempt('2026-09-01T10:00:00Z')])]);
    await store.banks.put(b);
    assert.deepEqual(await store.banks.get('Bio/Cells.quiz'), b);
  });

  t('unknown keys return null', async (store) => {
    assert.equal(await store.banks.get('nope'), null);
    assert.equal(await store.sessions.get('nope'), null);
    assert.equal(await store.pictures.get('nope.png'), null);
    assert.equal(await store.pictures.has('nope.png'), false);
    assert.equal(await store.settings.get('nope'), null);
    assert.equal(await store.meta.get('nope'), null);
  });

  t('session round trip, including pool keys, and delete', async (store) => {
    const state = { queue: ['a', 'b'], index: 1 };
    await store.sessions.put('Bio/Cells.quiz', state);
    await store.sessions.put('pool:A.quiz|B.quiz', { queue: ['x'] });
    assert.deepEqual(await store.sessions.get('Bio/Cells.quiz'), state);
    assert.deepEqual(await store.sessions.get('pool:A.quiz|B.quiz'), { queue: ['x'] });
    await store.sessions.delete('Bio/Cells.quiz');
    assert.equal(await store.sessions.get('Bio/Cells.quiz'), null);
    assert.notEqual(await store.sessions.get('pool:A.quiz|B.quiz'), null);
  });

  t('picture round trip stores a Blob', async (store) => {
    await store.pictures.put('fig1.png', new Blob(['pixels'], { type: 'image/png' }));
    assert.equal(await store.pictures.has('fig1.png'), true);
    const blob = await store.pictures.get('fig1.png');
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'image/png');
    assert.equal(await blob.text(), 'pixels');
  });

  t('settings round trip', async (store) => {
    const s = { order: 'weighted', count: 20 };
    await store.settings.put('Bio/Cells.quiz', s);
    assert.deepEqual(await store.settings.get('Bio/Cells.quiz'), s);
  });

  t('meta round trip', async (store) => {
    await store.meta.put('driveFolderId', 'abc123');
    await store.meta.put('lastSync', '2026-10-12T08:00:00Z');
    assert.equal(await store.meta.get('driveFolderId'), 'abc123');
    assert.equal(await store.meta.get('lastSync'), '2026-10-12T08:00:00Z');
  });

  t('list summarises banks from stats, sorted by path', async (store) => {
    await store.banks.put(
      bank('Z/Studied.quiz', [
        question('1', [attempt('2026-09-01T10:00:00Z'), attempt('2026-09-03T12:30:45Z')]),
        question('2', [attempt('2026-09-02T10:00:00Z')]),
        question('3'),
        question('4'),
      ]),
    );
    await store.banks.put(bank('A/Fresh.quiz', [question('1'), question('2')]));
    const list = await store.banks.list();
    assert.deepEqual(list.map((s) => s.path), ['A/Fresh.quiz', 'Z/Studied.quiz']);

    const [fresh, studied] = list;
    assert.deepEqual(fresh, {
      path: 'A/Fresh.quiz',
      name: 'Fresh',
      md5: 'md5-A/Fresh.quiz',
      questionCount: 2,
      lastStudied: null,
      mastery: 0,
      hasSession: false,
    });
    assert.equal(studied.questionCount, 4);
    assert.equal(studied.lastStudied, '2026-09-03T12:30:45Z');
    assert.equal(studied.mastery, 0.5);
    assert.ok(!('questions' in studied));
  });

  t('list reports hasSession only for banks with a session', async (store) => {
    await store.banks.put(bank('A.quiz', [question('1')]));
    await store.banks.put(bank('B.quiz', [question('1')]));
    await store.sessions.put('B.quiz', { queue: ['1'] });
    await store.sessions.put('pool:A.quiz|B.quiz', { queue: ['1'] });
    const list = await store.banks.list();
    assert.deepEqual(list.map((s) => [s.path, s.hasSession]), [['A.quiz', false], ['B.quiz', true]]);
  });

  t('delete removes the bank with its session and settings only', async (store) => {
    await store.banks.put(bank('A.quiz', [question('1')]));
    await store.banks.put(bank('B.quiz', [question('1')]));
    for (const p of ['A.quiz', 'B.quiz']) {
      await store.sessions.put(p, { queue: [] });
      await store.settings.put(p, { count: 5 });
    }
    await store.banks.delete('A.quiz');
    assert.equal(await store.banks.get('A.quiz'), null);
    assert.equal(await store.sessions.get('A.quiz'), null);
    assert.equal(await store.settings.get('A.quiz'), null);
    assert.notEqual(await store.banks.get('B.quiz'), null);
    assert.notEqual(await store.sessions.get('B.quiz'), null);
    assert.notEqual(await store.settings.get('B.quiz'), null);
    assert.deepEqual((await store.banks.list()).map((s) => s.path), ['B.quiz']);
  });

  t('putting a bank again replaces it', async (store) => {
    await store.banks.put(bank('A.quiz', [question('1'), question('2')], { md5: 'old' }));
    await store.banks.put(bank('A.quiz', [question('9')], { md5: 'new' }));
    const got = await store.banks.get('A.quiz');
    assert.equal(got.md5, 'new');
    assert.deepEqual(got.questions.map((q) => q.id), ['9']);
    assert.equal((await store.banks.list()).length, 1);
  });

  t('stored values are copies, not live references', async (store) => {
    const b = bank('A.quiz', [question('1')]);
    await store.banks.put(b);
    b.questions.push(question('2'));
    assert.equal((await store.banks.get('A.quiz')).questions.length, 1);
  });
}
