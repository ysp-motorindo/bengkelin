# Bengkelin

Offline cashier application for an Indonesian motorcycle workshop (single
shop, single computer). Electron + React + SQLite (better-sqlite3).
Specification: `docs/superpowers/specs/2026-09-30-bengkelin-design.md`.

## Developer guide

### Setup

- Node 24 and npm 12 (`allowScripts` in `package.json` approves the
  `better-sqlite3` and `electron` install scripts).
- `npm ci` installs the locked dependencies and downloads Electron.
- `npm start` runs the app in development (Vite dev server, DevTools on).

### Scripts

| Command                    | What it does                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | `tsc --noEmit` over `src`, `tests` and `scripts`                                                                                                                                    |
| `npm run lint`             | oxlint, then the oxfmt format check (`npm run lint:fix` fixes)                                                                                                                      |
| `npm run test:domain`      | pure domain tests (Vitest, plain Node)                                                                                                                                              |
| `npm run test:integration` | SQLite and service tests. Vitest runs under Electron's own Node (`ELECTRON_RUN_AS_NODE=1`, via `scripts/run-under-electron.mjs`), so better-sqlite3 loads exactly as in the app     |
| `npm run test:renderer`    | React tests (Vitest + jsdom)                                                                                                                                                        |
| `npm run test:e2e`         | `npm run build:app` (the unpackaged **automation build**), then Playwright drives it through `_electron`. Needs a display: on Linux without one, run `xvfb-run -a npm run test:e2e` |
| `npm run package`          | Electron Forge package for this OS/arch into `out/Bengkelin-<platform>-<arch>` (production fuses on)                                                                                |
| `npm run make`             | installers into `out/make`: Squirrel `Setup.exe` (Windows), zip (macOS, Linux), `.deb` (Linux) and `.rpm` (Linux, only where `rpmbuild` is installed)                               |
| `npm run release:check`    | inspects the packaged app (see below)                                                                                                                                               |
| `npm run smoke:packaged`   | launches the hardened packaged app (see below). Linux: `xvfb-run -a npm run smoke:packaged`                                                                                         |
| `npm run fixtures:db`      | regenerates `tests/fixtures/db/schema-vNNN-populated.sqlite` for the current schema                                                                                                 |
| `npm run print:samples`    | renders sample invoices for visual print review into `artifacts/`                                                                                                                   |

Test-only hooks (`BENGKELIN_DATA_DIR`, `BENGKELIN_TEST_*`) exist for the
automated tests. The app honours them only when unpackaged
(`app.isPackaged` is false); `release:check` and `smoke:packaged` verify that.

### Two builds: automation vs. hardened

- **Automation build** (`npm run build:app`, `electron .`): the e2e suite
  runs against it with Playwright. Playwright needs Electron's inspector,
  which the production fuses disable, so it cannot drive a packaged app.
- **Hardened package** (`npm run package` / `make`): fuses RunAsNode,
  NODE_OPTIONS and `--inspect` off; asar integrity and only-load-from-asar
  on; cookie encryption on (`scripts/release/production-fuses.mts`).
  Chromium's `--remote-debugging-*` switches are removed at startup, and
  `devTools` is off outside development. It is checked by:
  - `npm run release:check [-- --app <dir>]`: all 11 migrations bundled and
    contiguous, id/en locales with key parity, invoice and report
    templates, the platform better-sqlite3 `.node` unpacked from the asar,
    no remote `http(s)://` runtime references in the renderer (reviewed
    allowlist in `scripts/release/checks.mts`), the production CSP, the
    fuses (read with `@electron/fuses`), DevTools off, and test hooks gated
    on `app.isPackaged`.
  - `npm run smoke:packaged [-- --app <dir>]`: starts the binary with a
    throwaway profile, a Chromium net-log and host-resolver rules that
    block every non-local name, and asserts: it stays up for 10 s, creates
    and migrates `userData/bengkelin.sqlite` (latest schema, Bengkelin
    `application_id`), loads its window, makes no non-local request,
    ignores `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`,
    `--remote-debugging-port` and `BENGKELIN_DATA_DIR`, and exits cleanly
    on SIGTERM.

`--app` also accepts an unpacked installer payload, for example the
`usr/lib/bengkelin` folder of the `.deb`.

### CI

`.github/workflows/ci.yml` runs every gate on Ubuntu 24.04, Windows,
macOS 14 (arm64) and macOS 13 (x64), then packages, runs the release
checks, makes the installers, smoke-tests the package and uploads the
installers. There is no code signing and no auto-updater in v1.

### Client trial

Physical printing and the Windows/macOS checks are manual. The status of
every acceptance item, with evidence and the exact steps for each pending
check, is in `docs/testing/client-trial-checklist.md`.
