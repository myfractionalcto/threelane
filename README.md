# SnapScreen

Local screen + multi-cam recorder and reels/shorts editor for macOS.

> **Status:** milestone 1 — app shell only. No recording or editing logic yet.

## Develop

```bash
npm install
npm run dev      # starts Vite + Electron with hot reload
```

## Build an unsigned .dmg

```bash
npm run dist     # writes release/SnapScreen-<version>-<arch>.dmg
```

### Opening the unsigned .dmg on another Mac

Because we don't code-sign yet, macOS Gatekeeper will refuse to open the app
on first launch:

1. Open the `.dmg` and drag `SnapScreen.app` to `Applications`.
2. In Finder, **right-click → Open**, then click **Open** in the dialog.
   (Double-clicking will only show "can't be opened" and won't expose the
   override button.)
3. After the first launch, it opens normally like any other app.

We'll add real code signing when you have an Apple Developer account —
it's a flag-flip in `electron-builder.yml`.

## Layout

See [PLAN.md](PLAN.md) for the full architecture and milestone plan.
