# QVault Phone

A home-screen web app that studies the same question banks as QVault on the Mac. Banks
are pulled read-only from the `QVault` folder in Google Drive; progress stays on the
phone. One user, no server.

Design: `docs/superpowers/specs/2026-10-12-qvault-phone-design.md` in the QVault repo.

- `app/` — the static site GitHub Pages serves. No build step.
- `app/engine/` — the study engine, ported from QVaultKit.
- `test/` — `node --test` suites mirroring the Swift ones.
