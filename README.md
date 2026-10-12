# QVault Phone

A home-screen web app for one iPhone that studies the same question banks as QVault on
the Mac. Banks are pulled read-only from the `QVault` folder in Google Drive; progress
stays on the phone. No server, no accounts beyond your own Google sign-in.

Design: `docs/superpowers/specs/2026-10-12-qvault-phone-design.md` in the QVault repo.
Plan: `docs/plan.md`.

## Using it

1. Open the published address in Safari on the phone.
2. Share → **Add to Home Screen**. Open it from the home screen from then on.
3. Tap **Sign in**, choose your Google account, allow read-only Drive access.
4. The library downloads. Pictures arrive in the background and on first view.

It syncs when opened, when returning to it after a while, and on pull-to-refresh or the
Sync button. Progress on the phone is never sent anywhere; progress on the Mac is never
read.

## If the library disappears

Safari can clear a home-screen app's storage after a week or so of not using it. Open the
app and sign in again; the banks come straight back from Drive. Phone-side progress on
those banks is what gets lost.

## Layout

- `app/` — the static site. No build step. Every file is served as-is.
- `app/engine/` — the study engine, ported from QVaultKit with its tests.
- `app/store.js`, `storeIndexedDB.js` — banks, pictures, sessions, settings in IndexedDB.
- `app/sync.js`, `drive.js`, `auth.js` — Google sign-in and the Drive pull.
- `app/ui/` — library, setup sheet, study screen.
- `app/sw.js` — offline cache. Every new file under `app/` must be added to its list;
  `test/shell.test.js` fails otherwise. Bump the cache version when the list changes.
- `test/` — `npm test` runs everything with Node's test runner.

## Google sign-in

`app/config.js` holds the OAuth client id (public by design). The client is a "Web
application" in Google Cloud with `https://etucya.github.io` as an authorized JavaScript
origin, scope `drive.readonly`, consent screen left in Testing with one test user. To
rotate it, create a new client in the console and replace the id.

## Publishing

GitHub Pages serves `app/` from `main`. Push to `main` to update; the app picks the new
version up on its next launch.
