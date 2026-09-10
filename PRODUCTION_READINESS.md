# University production acceptance

Status: **engineering release candidate; not yet institutionally accepted**.
Candidate version: 0.1.3-rc.1. Assessment date: 2026-09-09. This is a record of evidence and remaining work, not a
security certification or a substitute for the university's acceptance process.

## Verified engineering changes in this candidate

- Renderer sandbox, context isolation, production CSP, blocked navigation/new
  windows, denied permission requests, and main-process IPC sender validation.
- Native file dialogs authorize circuit write destinations; export rejects path
  traversal and confirms replacement of additional VHDL files.
- File reads and writes have a 10 MiB limit. Saves write and flush a temporary file
  before replacing the destination. Renderer retains dirty state on failure or
  when newer edits were not included in a completed save.
- Native window close requests pass through Save / Don't Save / Cancel. Save
  cancellation or failure leaves the application open.
- Circuit imports are capped at 5,000 components, 10,000 wires and 50,000 segments; they validate document schema and finite values before replacing
  the current circuit; asynchronous operations cannot overwrite newer edits.
- Electron updated within its supported major and vulnerable build dependencies
  patched. npm audit is a known-advisory check, not a complete security assessment.
- PR CI runs typechecks, regression tests, dependency audit and production build
  on Windows and macOS. Release workflow repeats checks before packaging.
- macOS release workflow requires Developer ID signatures, Apple acceptance,
  stapled notarization ticket validation, and Gatekeeper assessment.
- VHDL exports have legal identifiers and preserve port connectivity; the UI
  explicitly identifies the output as a structural template requiring external models.

## Required before campus rollout

| Gate | Acceptance evidence | Owner / status |
| --- | --- | --- |
| Supported systems | EXE/DMG accepted by commissioning developer; IT must name Windows/macOS versions, architectures and managed-image restrictions | EXE/DMG confirmed; IT platform tests pending |
| Windows publisher identity | Signed EXE with valid timestamp and Authenticode verification, or written campus acceptance of unsigned pilot installer | Publisher + IT; unsigned today |
| Instructor correctness | Instructor-owned expected results for real course circuits, sequential timing, state machines, buses, checker and grading workflows | Teaching staff; pending |
| Install/upgrade/rollback | Fresh standard-user Windows and Mac installs; open old course files; save/reopen; upgrade and revert without losing data | IT + maintainer; pending |
| Accessibility | Keyboard-only and screen-reader review, contrast/zoom checks, and university-required accessibility documentation | University accessibility reviewer; pending |
| Work preservation | Save failure, cancelled close, malformed file and large simulation tests pass; users know unsaved work is not recovered after a crash | Engineering checks plus teaching pilot |
| Support and patching | Named support owner, incident channel, response expectations, security-update cadence and supported-version policy | University + maintainer; pending |
| Product terms | Scope, name/manual rights, commercial terms and handover responsibilities recorded in commissioning agreement | Commissioning parties; outside this code audit |

## Acceptance walkthrough

Run these on both target operating systems with the actual packaged candidate.
Record installer version, SHA256, OS version, result, and any issue number.

1. Install as a standard user. Launch, close, relaunch and uninstall. On macOS
   verify Gatekeeper accepts the downloaded DMG; on Windows record publisher status.
2. Open `samples/and-gate.ckt`. Check all four AND truth-table rows. Save As,
   reopen, and confirm geometry, labels, connectivity and input positions persist.
3. Open a real legacy/course circuit and compare expected simulator results
   against instructor reference values. Include feedback and sequential timing.
4. Make an edit and close the window: Cancel must preserve it; Save must write
   it; Don't Save must close only after explicit selection. Repeat with a failed
   save destination and a cancelled Save As dialog.
5. Load truncated JSON, an unsupported component, duplicate IDs and an oversized
   document. Show an error while preserving the existing open circuit.
6. Run the clock-divider and checker workflows. Large runs must fail visibly
   before freezing the editor. Check state-machine pin counts and checker file
   contents survive component placement.
7. Exercise keyboard menus, labels, timing view, zoom, printing and dialogs with
   assistive technology and the actual lab display settings.
8. If VHDL is in contract scope, supply/verify the external model library and run
   an independent HDL toolchain. Current structural-template export is not a
   complete synthesis/simulation feature and must not be sold as one.

## Scope limits

No exhaustive formal proof, penetration test, external accessibility evaluation,
or campus installation test has been completed by this repository audit. Tests
exercise specified behaviors, not every possible circuit. There is no automatic
crash-recovery autosave or in-app updater. Windows ARM64-native builds, MSI/PKG,
SSO, telemetry, license enforcement and cloud services are not provided or implied.

Do not overwrite a published release to ship these changes. Bump the version,
build a candidate, retain checksums, and publish after the agreed acceptance gates.
