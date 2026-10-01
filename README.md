# SimUaid Modernized

Desktop logic-circuit editor and simulator for Windows x64 and macOS Intel/Apple
Silicon. Circuit documents are saved locally as `.ckt` files. The application
requires no account or hosted service.

## Install

Download the installer from [GitHub Releases](https://github.com/dreamingofu/SimUAid-Modernized/releases).
On macOS, open the DMG and drag SimUaid to Applications. Use version 0.1.2 or later
for Developer ID signing and Apple notarization. Windows releases currently have
no Authenticode signature and may display a publisher warning.

The published release and the latest source may differ. See
[production acceptance](PRODUCTION_READINESS.md) before deploying to teaching labs.

## Basic workflow

1. Use the Parts menu to choose a component; click the canvas to place it.
2. Select Wire and connect component pins. Add input switches and output probes.
3. Toggle inputs and inspect outputs; use Simulate for clocked circuits and timing.
4. Save through File → Save / Save As. Files in `samples/` provide small examples.
5. Open a saved circuit with File → Open. Keep a backup before editing course material.
6. Tools → Boolean Expression / Truth Table analyzes an expression of up to four
   inputs (minterms, truth table, exact minimum SOP) and can create its gate circuit
   with 100 ns input stimuli. See [docs/LAB3_ACCEPTANCE.md](docs/LAB3_ACCEPTANCE.md).

Teaching staff piloting Lab 3 should start with the
[instructor pilot guide](docs/INSTRUCTOR_PILOT_GUIDE.md) (build identification,
preflight, classroom steps, expected results, stop criteria).

VHDL export creates a **structural template**, not a complete device model library.
External implementations are required for component declarations. Unsupported
configurable components are rejected; do not use this export as a verified FPGA
implementation or grading oracle.

## Development

Use Node.js 22 and npm. The lockfile currently requires legacy peer-dependency
resolution because the Vite/Electron-Vite integration declares older peer ranges.

```sh
npm ci --legacy-peer-deps
npm run dev
```

Before submitting changes:

```sh
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Electron's binary is installed by `postinstall`. macOS distribution builds require
a Developer ID Application identity; CI also requires notarization credentials.
See [RELEASING.md](RELEASING.md) for packaging and publication.

Pull-request CI also builds the unsigned Windows NSIS installer (no publishing).
On a disposable Windows runner, `scripts/ci/windows-installer-smoke.mjs`:

1. installs it per-user;
2. drives the Lab 3 workflow in the installed app;
3. reinstalls the same version, then uninstalls;
4. uploads the installer and evidence as workflow artifacts.

It is not a cross-version upgrade, code-signing, SmartScreen or campus-image test.

## Data and updates

The released desktop application works offline; it does not include analytics,
a cloud account, or automatic update downloads. Circuit files stay at paths chosen
in native file dialogs. Replace the application through a new installer to update;
keep the previous installer and copies of course circuits for rollback.

Saved documents use a temporary sibling file, flush its data, then replace the
chosen destination. Failed saves leave the current document dirty. There is no
crash-recovery autosave: unsaved work can still be lost on a process or power failure.

## Third-party components

Electron and Chromium notices are included in Windows distribution files and in
macOS `SimUaid.app/Contents/Resources`. Bundled npm dependencies retain their
individual license files inside `app.asar`. The legacy reference PDF in this
repository is not included in the application package.

Product licensing, support responsibilities, and university acceptance are governed
by the commissioning parties' agreement; this repository does not define that agreement.
