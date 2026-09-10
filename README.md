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
