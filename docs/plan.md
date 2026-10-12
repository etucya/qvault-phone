# QVault Phone — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A home-screen web app for one iPhone that studies QVault's `.quiz` banks pulled read-only from Google Drive, with the Mac's exact study rules and the phone's own progress.

**Architecture:** Static site (plain HTML/CSS/ES modules, no bundler) served by GitHub Pages. `app/engine/` is a faithful port of QVaultKit's session rules with Node tests mirroring the Swift ones. `app/store.js` keeps banks, pictures, progress and settings in IndexedDB behind a small adapter so the engine and sync logic are testable in Node. `app/sync.js` reads the Drive folder through the REST API. `app/ui/` renders three screens from plain DOM.

**Tech Stack:** HTML, CSS, JavaScript (ES2022 modules), IndexedDB, Service Worker, Google Identity Services (token client), Google Drive REST v3, `node --test` for tests. Dev dependency allowed for tests only: `fake-indexeddb`.

## Global Constraints

- Behaviour must match `/Users/ethankhotylev/Developer/QVault/docs/superpowers/specs/2026-10-12-qvaultkit-inventory.md` (the inventory). Where the plan and the inventory disagree, the inventory wins.
- Design: `/Users/ethankhotylev/Developer/QVault/docs/superpowers/specs/2026-10-12-qvault-phone-design.md`.
- No build step. Every file under `app/` is served as-is. Scripts are ES modules.
- No runtime dependencies. No framework. No CDN scripts except Google's `https://accounts.google.com/gsi/client`.
- Dates written to any JSON use ISO-8601 with whole seconds, no fractional part (`2026-09-02T14:36:12Z`).
- Theme tokens come from `app/theme.css` only. Every rounded shape uses one of the `--radius-*` tokens. Colours only from the tokens.
- Tap targets at least 44px tall. No hover-only affordances. No keyboard shortcuts.
- Nothing is ever written to Google Drive. Scope `drive.readonly`.
- Tests: `npm test` runs everything under `test/`. Each engine module has a matching test file. Property-style randomness tests use a seeded generator passed in; engine functions that randomize take a `random` function argument defaulting to `Math.random`.
- Commit after every task with a message describing the behaviour, ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Option order

**Files:**
- Create: `app/engine/optionOrder.js`
- Test: `test/optionOrder.test.js`

**Interfaces:**
- Produces:
  ```js
  export function identity(question) // -> number[]
  export function shuffled(question, random = Math.random) // -> number[]
  export function present(question, order) // -> question copy with reordered option texts and moved answer
  export function writtenLetter(shownLetter, question, order) // -> string | null
  export function isPinned(text) // -> boolean
  export function refersToOtherOptions(question) // -> boolean
  export function isTrueFalsePair(question) // -> boolean
  ```
  A `question` is the plain object from a `.quiz` file: `{id, type, prompt, options:[{letter,text}], answer, ...}`.

- [ ] Write tests mirroring inventory §3: shuffled is always a permutation and never written order for 4 options over 300 draws; two options over 60 draws yield both orders; tf never shuffled; a True/False mcq pair (any spelling, either written order) never shuffled; "All of the above" keeps its index; "None of these" keeps its index wherever written; "Both A and C" / "A and B" / "Only B" never shuffled; "Vitamin A" / "Hepatitis B" / "Type II collagen" / "Complex I" / "Only a small amount" do shuffle; present moves the answer with its text and keeps letters positional; writtenLetter maps back; invalid order ignored by present.
- [ ] Implement. Use `random()` for coin flips and Fisher–Yates.
- [ ] `npm test` green. Commit.

### Task 2: Session settings, state, and engine

**Files:**
- Create: `app/engine/settings.js`, `app/engine/sessionEngine.js`, `app/engine/dates.js`
- Test: `test/settings.test.js`, `test/sessionEngine.test.js`

**Interfaces:**
- `dates.js`: `export function isoSeconds(date)` → `"2026-09-02T14:36:12Z"`; `export function parseISO(string)` → Date.
- `settings.js`:
  ```js
  export const DEFAULT_SETTINGS = { scope:'all', rangeLower:null, rangeUpper:null, order:'shuffle', delay:{questions:5}, retireThreshold:1, maxQuestions:null, tags:[], shuffleOptions:true }
  export function decodeSettings(json)  // accepts the Swift encoding ({"questions":{"_0":5}}, {"minutes":{"_0":10}}, {"endOfSet":{}}) and the internal shape; fills defaults
  export function encodeSettings(settings) // Swift encoding, omits nulls
  export function questionsTagged(questions, tags) // inventory §2 tags rule
  export function scopedIDs(questions, settings) // inventory §2
  ```
- `sessionEngine.js`:
  ```js
  export function startSession(set, settings, now = new Date(), random = Math.random) // -> engine
  export function resumeSession(set, state, settings, now = new Date(), random = Math.random) // -> engine
  // engine is an object { set, state, undoStack, ...methods }:
  //   current(), isFinished(), repeatingCount(), counts() -> {cleared, repeating, total, remaining}
  //   answer(outcome, chose, ms, now) -> {retired, requeued, finished}
  //   skip(now), undoLastAnswer() -> boolean, toggleFlag(id) -> boolean
  //   update(id, question), removeQuestion(id), recordActiveTime(ms)
  //   persistableSet() -> set copy with session or null
  export function decodeState(json) / encodeState(state)   // SessionState shape, availableAt dates as ISO seconds
  ```
  `set` is `{name, questions:[...]}` as in a `.quiz` file; attempts are `{at: Date, outcome, ms, chose?}` in memory and ISO strings in JSON.

- [ ] Port SessionEngineTests (48) and SessionUndoTests (9) from `/Users/ethankhotylev/Developer/QVault/Tests/QVaultKitTests/` — read them and port each one; same names in camelCase. Add settings decode/encode round-trip tests including the Swift delay encoding and a sessions saved without `activeMs`.
- [ ] Implement per inventory §2, including normalize-position for minutes mode and the retire-threshold-only-for-missed rule.
- [ ] `npm test` green. Commit.

### Task 3: Stats and keywords

**Files:**
- Create: `app/engine/stats.js`, `app/engine/keywords.js`
- Test: `test/stats.test.js`, `test/keywords.test.js`

**Interfaces:**
```js
// stats.js
export function summary(question) // {seen, correct, wrong, shaky, dontKnow, accuracy|null, averageMs|null, lastMs|null, distractors:{letter:count}}
export function isTrouble(question), masteryBand(question) // 'never'|'trouble'|'shaky'|'solid'
export function setSummary(questions) // {never, trouble, shaky, solid, flagged, accuracy|null, mastery}
export function lastStudied(questions) // Date|null
// keywords.js
export function keywordHits(typed, keywords) // [{keyword, hit}]
export function highlightSegments(answerText, hitKeywords) // [{text, highlighted}] preserving spaces and punctuation outside the core
```
- [ ] Port StatsTests (12) and the highlighting expectations from inventory §6/§7. Include: trouble needs ≥3 attempts; averageMs truncates; multi-word keyword never highlights; punctuation sits outside the highlight.
- [ ] Implement.
- [ ] `npm test` green. Commit.

### Task 4: Study model

**Files:**
- Create: `app/engine/studyModel.js`
- Test: `test/studyModel.test.js`

**Interfaces:**
```js
export function createStudyModel({ set, settings, resume, now = () => new Date(), random = Math.random, persist, remove })
// state: current (presented question with shuffled options), currentAsWritten, revealed, chosen (shown letter), lastOutcome, typedAnswer, hits
// methods: choose(letter), reveal(), grade(outcome), dontKnow(), advance(), skip(), repeatLater(), undo(), pause(), resume(), activeMs(at), questionElapsedMs(at), progress(), isFinished(), isPaused, canUndo, canRepeatLater
// persist(setCopy) is called after every change that the Mac would save; errors are kept in model.saveError
```
- [ ] Port StudyModelTests (51) from `/Users/ethankhotylev/Developer/QVault/Tests/QVaultAppTests/StudyModelTests.swift`, skipping only tests about keyboard focus or AppKit. Includes the stopwatch tests, option-shuffle tests (the `OrderCounter` ones), repeat-later, undo, open-answer grading, time freeze at reveal.
- [ ] Implement per inventory §2 "App wrapper rules".
- [ ] `npm test` green. Commit.

### Task 5: Pooling several banks

**Files:**
- Create: `app/engine/pool.js`
- Test: `test/pool.test.js`

**Interfaces:**
```js
export function buildPool(sources) // sources: [{path, name, modified: Date, questions}] in library sort order (modified desc, ties path asc) -> { title, questions, origins: Map<id, path> }
export function writeBack(pool, questions, banks) // -> list of {path, questions} for banks whose questions changed, per inventory §5 store save rule
```
- [ ] Port the `allSets` cases of VirtualSetTests (dedupe by id, first source wins, non-qualifying copies do not claim is moot for allSets, title "N sets" vs single name, origins) and VirtualSetStoreTests (save skips unknown ids, writes only dirty banks, keeps each bank's own session).
- [ ] Implement.
- [ ] `npm test` green. Commit.

### Task 6: Storage

**Files:**
- Create: `app/store.js`, `app/storeMemory.js` (adapter for tests), `app/storeIndexedDB.js`
- Test: `test/store.test.js` (uses `fake-indexeddb` dev dependency for the IndexedDB adapter plus the memory adapter)

**Interfaces:**
```js
export function openStore(adapter) // -> store
// store.banks: list() -> [{path, name, md5, questionCount, lastStudied, mastery}], get(path), put(bank), delete(path)
// store.sessions: get(key), put(key, state), delete(key)
// store.pictures: get(name) -> Blob|null, put(name, blob), has(name)
// store.settings: get(path) -> settings|null, put(path, settings)
// store.meta: get(key), put(key, value)
// bank record: { path, name, md5, modified: ISO, questions: [...] } with phone stats inside questions
```
- [ ] Tests: round trips for every store; `list()` summaries computed from stats; delete cascades a bank's session and settings.
- [ ] Implement. IndexedDB database `qvault`, version 1, object stores named as above. Request `navigator.storage.persist()` in `storeIndexedDB` on open (ignored when unavailable).
- [ ] `npm test` green. Commit.

### Task 7: Drive sync

**Files:**
- Create: `app/drive.js` (REST calls over an injected `fetch` and token getter), `app/sync.js` (merge rules), `app/auth.js` (Google Identity Services token client wrapper)
- Test: `test/sync.test.js` (fake fetch), `test/drive.test.js`

**Interfaces:**
```js
// drive.js
export function createDrive({ fetch, getToken })
//   findFolder(name, parentId='root') -> id|null
//   listTree(folderId) -> [{id, path, name, md5Checksum, modifiedTime, mimeType}] recursively, skipping names starting with "." except ".media" (listed separately: mediaIndex -> Map<name, id>)
//   download(fileId) -> ArrayBuffer   (files.get?alt=media)
// sync.js
export async function syncLibrary({ drive, store, log }) // -> {added, updated, removed, failed:[{path, reason}]}
export function mergeBank(existing /*bank|null*/, incoming /*parsed .quiz*/, path, md5) // -> bank, per design "Sync rules": keep phone stats/flagged/note by id, replace content, drop missing, strip session
export async function fetchPicture({ drive, store, mediaIndex, name }) // -> Blob|null, caches
// auth.js
export function createAuth({ clientId, scope }) // signIn() -> token, getToken() (silent refresh, or null), signOut(), account()
```
- [ ] Tests: listTree walks nested folders and pagination (`nextPageToken`); skips `.Backups`/`.Trashed`; mergeBank keeps stats by id and drops removed questions; sync removes banks gone from Drive and their sessions; a parse failure keeps the old bank and reports it; unchanged md5 downloads nothing; session queue pruned of removed ids.
- [ ] Implement. The Drive folder is found by name `QVault` under `root` and its id cached in `meta`. Fields requested: `files(id,name,md5Checksum,modifiedTime,mimeType,parents),nextPageToken`.
- [ ] `npm test` green. Commit.

### Task 8: App shell, library screen, sign-in

**Files:**
- Create: `app/index.html`, `app/app.css`, `app/main.js`, `app/ui/library.js`, `app/ui/components.js` (pill button, mastery ring, banner), `app/manifest.webmanifest`, `app/icons/icon-180.png`, `app/icons/icon-512.png`, `app/sw.js`, `app/config.js` (`export const GOOGLE_CLIENT_ID = "..."`, `export const LIBRARY_FOLDER = "QVault"`)

- [ ] `index.html`: viewport with `viewport-fit=cover`, `apple-mobile-web-app-capable`, status bar style black-translucent, theme colour `--ground`, manifest link, apple-touch-icon, loads `main.js` as a module and the GIS script.
- [ ] Library screen: breadcrumb of the current folder; rows for subfolders (chevron) and banks (name, "N questions · last studied", mastery ring, "New" pill); tapping a bank opens Setup; long-press (500 ms) enters selection, tapping toggles, a bottom bar reads "Study N banks"; first run shows only the sign-in button and a one-line explanation; a status line at the bottom shows account, last sync, and a Sync button; pull-to-refresh (touch drag at top > 80px) triggers sync. Save-error and sync-error banners from `components.js`.
- [ ] Service worker caches the app shell (every file under `app/` listed explicitly) with a version string; network-first for the shell, cache fallback. Manifest: name "QVault", display standalone, background and theme colours from tokens, icons.
- [ ] Icons: render the Mac's wordmark idea — a rounded square `--ground` background with a "Q" in the primary gradient — with a small Node script `scripts/icons.mjs` that writes PNGs with no dependencies (write the PNG encoder, it is ~60 lines), committed outputs.
- [ ] Manual check in a browser at 390×844 (the Claude built-in browser is allowed; the user's own devices are not). Commit.

### Task 9: Setup sheet

**Files:**
- Create: `app/ui/setup.js`
- Modify: `app/main.js` (route)

- [ ] A bottom sheet over the library: title (bank name or "N banks"), subtitle "N questions" / "count of total" / "stopped with N to go"; sections exactly as the Mac: Which questions (All / Unseen / Missed / Flagged / Range with two steppers), Tags (chips with counts, alphabetical, live in-scope count updates the subtitle and the range upper bound), Order (Shuffle / CSV order), Repeat missed after (N questions / N minutes / end of set, with a stepper), Retire after getting it right (1× / 2× / 3×), Stop after (No limit / 25 / 50), Answer choices (Shuffle / As written). Resume and Start fresh buttons when a session exists (Start fresh confirms when answers are recorded), otherwise Start. Settings remembered per bank via `store.settings`; pools use key `pool:<sorted paths>`.
- [ ] Start builds the set (single bank, or `buildPool` over the selected banks in library sort order), creates the study model with `persist` writing back through `store` (single bank: put the bank with the session; pool: `writeBack` to each bank, session under the pool key), and routes to Study.
- [ ] Commit.

### Task 10: Study screen

**Files:**
- Create: `app/ui/study.js`, `app/ui/picture.js`
- Modify: `app/main.js`

- [ ] Header: "Question n of N", "k repeating" in `--warn`, stopwatch (m:ss, h:mm:ss past an hour, holds while paused), question clock (freezes at recorded ms after answering), progress track (cleared gradient + repeating warn segment); a pause button and a close button (both 44px).
- [ ] Picture above the prompt when `question.image`: from `store.pictures`, else fetched via `fetchPicture`, "Loading picture…" then the image at full column width capped at 45% of the viewport height; tap opens full-screen with pinch-zoom allowed (`touch-action: pinch-zoom` on an overlay with the image), tap or swipe down closes. "Picture unavailable" when the fetch fails.
- [ ] Choice questions: options as full-width tap targets (letter badge + text, min 56px), selected/correct/wrong colouring as the Mac (good/bad); after reveal the feedback panel (Correct / Not quite — the right answer was X), explanation, action row (Don't know before reveal; after reveal: Repeat later when allowed, Undo, Next). Skip button in the header menu. Tapping the correct option again after reveal advances, mirroring the Mac's key rule.
- [ ] Open questions: a textarea (grows with content), Reveal button; after reveal: the typed answer, the model answer with highlighted keyword cores, "You hit X of Y key terms." and the Missed line, then Got it / Missed it / I don't know. Missed it and I don't know move on immediately.
- [ ] Pause overlay: Resume, Exit. Finished panel: counts and an Exit button. After answering, the screen scrolls smoothly so the explanation is in view; the next question starts at the top.
- [ ] Persist after every change; a save failure shows the banner. Leaving the study screen keeps the session resumable.
- [ ] Manual check at 390×844 and at 430×932 in the built-in browser with a local bank fixture (`test/fixtures/sample.quiz`). Commit.

### Task 11: Wire sync into the app and the picture prefetch

**Files:**
- Modify: `app/main.js`, `app/ui/library.js`

- [ ] On launch: open store, render library from store immediately, then if online and signed in run `syncLibrary` and re-render; show "Syncing…" in the status line; errors to the banner. Sign-in button runs `auth.signIn()` then sync.
- [ ] After a sync, prefetch pictures for questions without a cached picture, 3 at a time, lowest priority, abortable when a study session starts.
- [ ] Commit.

### Task 12: Publish

- [ ] Create the GitHub repository `etucya/qvault-phone` (public), push `main`, enable Pages from `main` with `/app` as the folder (or a `docs/`-style setting; use the Pages "deploy from branch" with folder `/app` if available, otherwise move the site to `/docs`). Only after the user has confirmed the repository may be created.
- [ ] Put the user's Client ID in `app/config.js`. Confirm the live URL loads, the sign-in works for the test user, and a sync pulls the library.
- [ ] Write `README.md` instructions: adding to the home screen, what to do when storage is evicted, how to rotate the client id.
