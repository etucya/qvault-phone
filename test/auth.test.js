import { test, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../app/auth.js';

// A fake Google Identity Services: initTokenClient records its options, requestAccessToken
// records each call, and the test answers (or never answers) through respond().
function installGoogle() {
  const log = { inits: [], requests: [], revoked: [], revokeCallbacks: [] };
  let callback = null;
  globalThis.google = {
    accounts: {
      oauth2: {
        initTokenClient(options) {
          log.inits.push(options);
          callback = options.callback;
          return { requestAccessToken: (args) => log.requests.push(args) };
        },
        revoke(token, done) {
          log.revoked.push(token);
          log.revokeCallbacks.push(done);
        },
      },
    },
  };
  log.respond = (response) => callback(response);
  return log;
}

const grant = (access_token, expires_in = 3600) => ({ access_token, expires_in });

// A fresh localStorage per test: what the home-screen app keeps between launches.
function installStorage() {
  const items = new Map();
  const storage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  return items;
}
let saved;
beforeEach(() => {
  saved = installStorage();
});

afterEach(() => {
  mock.timers.reset();
  delete globalThis.google;
  delete globalThis.fetch;
});

// signIn finishes with an email lookup; stub fetch so it never touches the network.
function stubFetch() {
  globalThis.fetch = async () => new Response(JSON.stringify({ email: 'me@example.com' }), { status: 200 });
}

test('signIn asks for consent and resolves to the token', async () => {
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const pending = auth.signIn();
  assert.deepEqual(log.requests, [{ prompt: 'consent' }]);
  log.respond(grant('t1'));
  assert.equal(await pending, 't1');
  assert.equal(await auth.getToken(), 't1');
});

test('concurrent signIn calls share one request', async () => {
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const a = auth.signIn();
  const b = auth.signIn();
  assert.equal(log.requests.length, 1);
  log.respond(grant('t1'));
  assert.deepEqual(await Promise.all([a, b]), ['t1', 't1']);
});

test('concurrent getToken calls on an expired token issue one silent request and all get the token', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const first = auth.signIn();
  log.respond(grant('old', 3600));
  await first;
  log.requests.length = 0;

  mock.timers.tick(3_600_000); // the token is now past its expiry
  const calls = [auth.getToken(), auth.getToken(), auth.getToken()];
  assert.equal(log.requests.length, 1, 'one request for three callers');
  assert.deepEqual(log.requests[0], { prompt: '' });
  log.respond(grant('new'));
  assert.deepEqual(await Promise.all(calls), ['new', 'new', 'new']);
  assert.equal(await auth.getToken(), 'new', 'fresh again, no further request');
  assert.equal(log.requests.length, 1);
});

test('getToken is null without a prior sign-in and asks for nothing', async () => {
  const log = installGoogle();
  const auth = createAuth({ clientId: 'cid' });
  assert.equal(await auth.getToken(), null);
  assert.equal(log.requests.length, 0);
});

test('a silent refresh that never answers resolves null after 5 s, and the next try starts clean', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const first = auth.signIn();
  log.respond(grant('old', 3600));
  await first;
  log.requests.length = 0;
  mock.timers.tick(3_600_000);

  const stuck = auth.getToken();
  const joined = auth.getToken();
  let settled = false;
  stuck.then(() => { settled = true; });
  mock.timers.tick(4_999);
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting just before 5 s');
  mock.timers.tick(1);
  assert.equal(await stuck, null);
  assert.equal(await joined, null);
  assert.equal(log.requests.length, 1);

  const retry = auth.getToken();
  assert.equal(log.requests.length, 2, 'a new request, not the abandoned one');
  log.respond(grant('again'));
  assert.equal(await retry, 'again');
});

test('signOut clears the token, the account and revokes it', async () => {
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const signedIn = auth.signIn();
  log.respond(grant('t1'));
  await signedIn;
  assert.equal(auth.account(), 'me@example.com');

  const out = auth.signOut();
  log.revokeCallbacks[0]();
  await out;
  assert.deepEqual(log.revoked, ['t1']);
  assert.equal(auth.account(), null);
  assert.equal(await auth.getToken(), null, 'no token and no silent renewal after signing out');
  assert.equal(log.requests.length, 1);
});

test('signOut does not hang when the revoke never calls back', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const signedIn = auth.signIn();
  log.respond(grant('t1'));
  await signedIn;

  let done = false;
  const out = auth.signOut().then(() => { done = true; });
  await Promise.resolve();
  mock.timers.tick(4_999);
  await Promise.resolve();
  assert.equal(done, false);
  mock.timers.tick(1);
  await out;
  assert.equal(done, true);
  assert.equal(await auth.getToken(), null);
});

// ---------------------------------------------------------------------------------------
// Consent remembered between launches

test('consent is remembered, so a cold launch gets a token silently without a tap', async () => {
  const log = installGoogle();
  stubFetch();
  const first = createAuth({ clientId: 'cid' });
  const signedIn = first.signIn();
  log.respond(grant('t1'));
  await signedIn;
  assert.equal(saved.get('qvault.consented'), 'true');

  // The app is closed and opened again from the home screen: a new page, no token in memory.
  const relaunched = createAuth({ clientId: 'cid' });
  log.requests.length = 0;
  const pending = relaunched.getToken();
  assert.deepEqual(log.requests, [{ prompt: '' }], 'a silent request, no consent screen');
  log.respond(grant('t2'));
  assert.equal(await pending, 't2');
});

test('with consent remembered, signIn asks silently first and does not show consent again', async () => {
  saved.set('qvault.consented', 'true');
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const a = auth.signIn();
  const b = auth.signIn();
  await Promise.resolve();
  assert.deepEqual(log.requests, [{ prompt: '' }], 'one request for both callers');
  log.respond(grant('t1'));
  assert.deepEqual(await Promise.all([a, b]), ['t1', 't1']);
});

test('with consent remembered, a silent sign-in that comes back empty falls back to consent', async () => {
  saved.set('qvault.consented', 'true');
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const pending = auth.signIn();
  await Promise.resolve();
  log.respond({ error: 'interaction_required' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.requests, [{ prompt: '' }, { prompt: 'consent' }]);
  log.respond(grant('t1'));
  assert.equal(await pending, 't1');
});

test('signOut forgets the remembered consent', async () => {
  const log = installGoogle();
  stubFetch();
  const auth = createAuth({ clientId: 'cid' });
  const signedIn = auth.signIn();
  log.respond(grant('t1'));
  await signedIn;
  const out = auth.signOut();
  log.revokeCallbacks[0]();
  await out;
  assert.equal(saved.has('qvault.consented'), false);
  assert.equal(await createAuth({ clientId: 'cid' }).getToken(), null, 'the next launch waits for a tap');
});
