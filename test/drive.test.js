import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrive } from '../app/drive.js';
import { fakeDrive } from './fixtures/fakeDrive.js';

const FOLDER = 'application/vnd.google-apps.folder';

function library() {
  const fake = fakeDrive({ pageSize: 2 });
  const root = fake.folder('QVault', 'root', { id: 'lib' });
  fake.file('Top.quiz', root, '{}', { id: 'top' });
  const bio = fake.folder('Biology', root, { id: 'bio' });
  fake.file('Blood.quiz', bio, '{}', { id: 'blood' });
  fake.file('Cells.quiz', bio, '{}', { id: 'cells' });
  fake.file('notes.txt', bio, 'x', { id: 'txt' });
  fake.file('Old.quiz', bio, '{}', { id: 'old', trashed: true });
  const deep = fake.folder('Unit 2', bio, { id: 'deep' });
  fake.file('Hearts.quiz', deep, '{}', { id: 'hearts' });
  const backups = fake.folder('.Backups', root, { id: 'backups' });
  fake.file('Top.quiz', backups, '{}', { id: 'backup-top' });
  fake.folder('.Trashed', root, { id: 'trashedfolder' });
  fake.file('.qvault-order.json', root, '[]', { id: 'order' });
  const media = fake.folder('.media', root, { id: 'media' });
  fake.file('abc.png', media, 'png-bytes', { id: 'img1' });
  fake.file('def.jpg', media, 'jpg-bytes', { id: 'img2' });
  fake.file('gone.png', media, 'x', { id: 'img3', trashed: true });
  fake.file('Inside.quiz', media, '{}', { id: 'inside' });
  return fake;
}

const driveOver = (fake, token = 'tok') => createDrive({ fetch: fake.fetch, getToken: async () => token });

test('findFolder looks the name up under root and returns its id', async () => {
  const fake = library();
  const drive = driveOver(fake);
  assert.equal(await drive.findFolder('QVault'), 'lib');
  const q = fake.calls[0].url.searchParams.get('q');
  assert.equal(q, `name = 'QVault' and 'root' in parents and mimeType = '${FOLDER}' and trashed = false`);
  assert.equal(fake.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('findFolder returns null when nothing matches, and searches under a given parent', async () => {
  const fake = library();
  const drive = driveOver(fake);
  assert.equal(await drive.findFolder('Nope'), null);
  assert.equal(await drive.findFolder('Biology', 'lib'), 'bio');
  assert.equal(await drive.findFolder('Biology'), null);
});

test('findFolder escapes single quotes in the name', async () => {
  const fake = fakeDrive();
  fake.folder("Ethan's QVault", 'root', { id: 'q' });
  const drive = driveOver(fake);
  assert.equal(await drive.findFolder("Ethan's QVault"), 'q');
  assert.match(fake.calls[0].url.searchParams.get('q'), /name = 'Ethan\\'s QVault'/);
});

test('listTree walks nested folders across pages and returns banks with paths', async () => {
  const fake = library();
  const { banks } = await driveOver(fake).listTree('lib');
  const byPath = Object.fromEntries(banks.map((b) => [b.path, b]));
  assert.deepEqual(Object.keys(byPath).sort(), ['Biology/Blood.quiz', 'Biology/Cells.quiz', 'Biology/Unit 2/Hearts.quiz', 'Top.quiz']);
  assert.deepEqual(byPath['Biology/Unit 2/Hearts.quiz'], {
    id: 'hearts',
    path: 'Biology/Unit 2/Hearts.quiz',
    name: 'Hearts',
    md5Checksum: fake.files.get('hearts').md5Checksum,
    modifiedTime: '2026-10-12T12:00:00.000Z',
  });
  // More than one page was requested for the folders with more than two children.
  assert.ok(fake.calls.some((c) => c.url.searchParams.get('pageToken') === '2'));
});

test('listTree asks for the documented fields, page size, and excludes trashed files', async () => {
  const fake = library();
  const { banks, mediaIndex } = await driveOver(fake).listTree('lib');
  for (const call of fake.calls) {
    assert.equal(call.url.searchParams.get('fields'), 'files(id,name,md5Checksum,modifiedTime,mimeType,parents),nextPageToken');
    assert.equal(call.url.searchParams.get('pageSize'), '1000');
    assert.match(call.url.searchParams.get('q'), /trashed = false/);
  }
  assert.ok(!banks.some((b) => b.id === 'old'));
  assert.ok(!mediaIndex.has('gone.png'));
});

test('listTree skips dot folders, never opening .Backups or .Trashed', async () => {
  const fake = library();
  const { banks } = await driveOver(fake).listTree('lib');
  assert.ok(!banks.some((b) => b.id === 'backup-top' || b.path.startsWith('.')));
  const opened = fake.calls.map((c) => c.url.searchParams.get('q'));
  assert.ok(!opened.some((q) => q.includes("'backups' in parents") || q.includes("'trashedfolder' in parents")));
});

test('listTree indexes files directly inside the root .media folder by name', async () => {
  const fake = library();
  const { banks, mediaIndex } = await driveOver(fake).listTree('lib');
  assert.ok(mediaIndex instanceof Map);
  assert.deepEqual([...mediaIndex.entries()].sort(), [['Inside.quiz', 'inside'], ['abc.png', 'img1'], ['def.jpg', 'img2']]);
  assert.ok(!banks.some((b) => b.id === 'inside'), '.media is not walked for banks');
});

test('a .media folder below the root is skipped like any dot folder', async () => {
  const fake = fakeDrive();
  const root = fake.folder('QVault', 'root', { id: 'lib' });
  const sub = fake.folder('Sub', root, { id: 'sub' });
  const media = fake.folder('.media', sub, { id: 'submedia' });
  fake.file('x.png', media, 'x', { id: 'x' });
  const { mediaIndex } = await driveOver(fake).listTree('lib');
  assert.equal(mediaIndex.size, 0);
});

test('download returns the file bytes as an ArrayBuffer', async () => {
  const fake = library();
  const buffer = await driveOver(fake).download('img1');
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal(new TextDecoder().decode(buffer), 'png-bytes');
  const call = fake.calls.at(-1);
  assert.equal(call.url.pathname, '/drive/v3/files/img1');
  assert.equal(call.url.searchParams.get('alt'), 'media');
});

test('a 401 throws an error naming the status and saying unauthorized', async () => {
  const fake = library();
  fake.failWith(401);
  const drive = driveOver(fake);
  await assert.rejects(drive.findFolder('QVault'), (err) => /401/.test(err.message) && /unauthorized/.test(err.message));
  await assert.rejects(drive.download('img1'), /unauthorized/);
});

test('a 403 is unauthorized too; other failures name the status only', async () => {
  const fake = library();
  fake.failWith(403);
  await assert.rejects(driveOver(fake).listTree('lib'), (err) => /403/.test(err.message) && /unauthorized/.test(err.message));
  const other = library();
  other.failWith(500);
  await assert.rejects(driveOver(other).download('img1'), (err) => /500/.test(err.message) && !/unauthorized/.test(err.message));
});

test('no token means unauthorized without calling Drive', async () => {
  const fake = library();
  await assert.rejects(driveOver(fake, null).findFolder('QVault'), /unauthorized/);
  assert.equal(fake.calls.length, 0);
});

test('auth.js imports cleanly outside a browser and reports no token', async () => {
  const { createAuth } = await import('../app/auth.js');
  const auth = createAuth({ clientId: 'x' });
  assert.equal(await auth.getToken(), null);
  assert.equal(auth.account(), null);
  await auth.signOut();
  await assert.rejects(auth.signIn(), /not loaded/);
});
