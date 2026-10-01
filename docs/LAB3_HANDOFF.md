# Lab 3 handoff

## Current state

Updated for task_f8a364ab2199: release prep for **0.1.3-rc.2**, after PR #13 was merged.

- **Branch:** `dreamingofu/release-0.1.3-rc.2`, base `6213a6e9fe6670b8230f6f97024c437bcacc5da1` (the PR #13 merge). The root owns git, the PR, the tag, Actions runs and publication. The writer does not commit, push, tag or publish.
- **Version:** `package.json` and the root version fields of `package-lock.json` (top level and `packages[""]`) are now `0.1.3-rc.2`. No dependency entries changed.
- **`RELEASING.md`:** installer filenames and tag examples now say rc.2. It also notes that the Release workflow smoke-tests the Windows installer before it creates the draft release.
- **`.github/workflows/release.yml`:** two new steps in the `build` job, both Windows-only:
  1. Right after **Build Windows installer**: `node scripts/ci/windows-installer-smoke.mjs --evidence installer-smoke-evidence`, with a 20-minute timeout.
  2. Always upload a `Windows-installer-smoke-evidence` artifact. Its name does not match the `SimUaid-*` pattern the `release` job downloads, so it is never attached to the release.

  A failed smoke test fails the build job, so no draft release is created. Signing, notarization, permissions, secrets and the publication policy are unchanged.
- **`docs/INSTRUCTOR_PILOT_GUIDE.md`:** the candidate is now rc.2, with installer and DMG names, the hash command and `SHA256SUMS.txt` matching. The sentence about two builds sharing a version number is removed. Windows deployment now points to the published `v0.1.3-rc.2` release, its `SHA256SUMS.txt` and the Release run's smoke evidence, instead of the latest PR #13 assets.
- **Preserved as history:** the Lab 3 evidence, `samples/lab3-assigned.ckt` (its metadata still says appVersion 0.1.3-rc.1), the old acceptance hashes and the run references below.
- **Writer checks:**
  - the two version fields agree, and the lockfile diff is the version lines only
  - `release.yml` parses with js-yaml, and the new steps are in the right order with the right conditions and artifact name
  - `node --check scripts/ci/windows-installer-smoke.mjs` passes
- **Still to do (root):** commit, tag, the Release workflow run with its full checks and the Windows smoke test, review of the draft release, and publication.

### Previous current state (task_9f7a8a28e1d7, the approved follow-ups)

- **Branch:** `dreamingofu/lab3-simuaid-logic-sim` on base `9d2aaa6`. The root owns git, staging, the draft PR and GitHub runs. The writer does not commit or push.
- **Lab 3 code:** accepted and unchanged in this task. The root's final checks on the Lab 3 diff:
  - typecheck exit 0
  - 14677 tests passed, 4 skipped
  - build exit 0
  - audit: 0 high vulnerabilities
  - native macOS built-app save/open smoke test passed
- **Windows CI:** this task adds it.
  - `.github/workflows/ci.yml` has a new job, `windows-installer`. It needs `validate`, runs on `windows-latest`, and runs on PRs and pushes to main. It does not invoke the release workflow and uses no secrets or signing. It builds with `npm run build:win` (which already passes `--publish never`) and `CSC_IDENTITY_AUTO_DISCOVERY=false`.
  - The job runs `scripts/ci/windows-installer-smoke.mjs`, which needs only Node 22 built-ins.
  - It always uploads two artifacts for 14 days: `windows-installer-smoke-evidence` (JSON report and screenshots) and `windows-installer-unsigned` (the installer).
- **What the smoke test does:**
  1. Refuses to run anywhere except a GitHub Actions Windows runner.
  2. Records the installer's SHA-256.
  3. Installs silently for the current user (`/S /currentuser /D=<RUNNER_TEMP>\simuaid-installer-smoke\install`).
  4. Checks the registry: the HKCU uninstall entry (uninstall commands and version), the install location in `HKCU\Software\<GUID>`, and that nothing was written to HKLM.
  5. **Session 1a:** changes View → Change Graphics Mode, then exits gracefully with File → Exit.
  6. Writes a sentinel file into the app's userData folder.
  7. **Session 1b:** runs the Lab 3 workflow through the real UI over a loopback DevTools port:
     - Tools → Boolean with the assigned expression; the 16-row F column must be `0100010101010111`, plus the minterm list and minimum SOP
     - Create circuit, Window → Timing, Simulate → Go; the status bar must read `Time: 1600 ns` at 100 ns/div
     - reads the timing canvas pixels at each interval midpoint; A–D and F must match exactly
     - View → Fit To Window, then screenshots
     - ends by terminating the app's exact process tree, because the generated circuit is unsaved and the app correctly asks to save
  8. Reinstalls the same version. The app executable's hash must match, and the sentinels must be unchanged.
  9. **Session 2:** the graphics preference must have survived; `A +` must show its error; then File → Exit.
  10. Uninstalls with `/S /currentuser _?=<dir>`. The app must be removed and both registry keys deleted, while the userData sentinel and the student circuit copy remain.
  11. Cleanup touches only processes under the install folder and the install folder itself.
- **Not covered by the smoke test:**
  - cross-version upgrade or migration
  - campus images, SmartScreen, AppLocker
  - code signing
  - saving or opening files through the installed app on Windows (the student circuit is a copied file, checked by hash)
- **Docs:**
  - new `docs/INSTRUCTOR_PILOT_GUIDE.md`: build identification by commit and hash, platform limits, preflight, a 15–25 minute activity, expected results, delays and hazards, safety checks, rubric, issue template, stop criteria
  - README links to the guide and describes the Windows CI
- **Writer checks for this task** (local only; nothing was installed or run on Windows):
  - `node --check` passes
  - `--plan` output is correct
  - the script refuses to run off the runner
  - assertions on the pure helpers (`parseReg`, `assertPlainPath`, install/uninstall arguments) pass
  - `ci.yml` parses with js-yaml
  - Node 22.23.3 and Node 26 built-in WebSocket send no Origin header, so the script passes no `--remote-allow-origins` flag
  - a headless dry run in chrome-headless-shell, against the built `out/renderer` with stubbed IPC, passes the three renderer workflows: exact waveform vectors, the error text, and Exit calling `window.close`
- **Commit and PR:** the root committed the accepted Lab 3 code plus the Windows CI infrastructure as `cca3f0e8e71be36cf9c845c27fd2b6c52d9cef07`. Draft PR: https://github.com/dreamingofu/SimUAid-Modernized/pull/13. The docs (README, instructor guide, this handoff) are later writer edits, staged by the root.
- **Windows CI result (reported by the root):** run 36804334226 (https://github.com/dreamingofu/SimUAid-Modernized/actions/runs/36804334226) succeeded on `cca3f0e8e71be36cf9c845c27fd2b6c52d9cef07`. All three jobs passed: Validate (macos-15), Validate (windows-latest) and the Windows installer smoke test. Runner: win25-vs2026 image 20260922.246.2, Node 22.23.2. Installer SHA-256 `6a5683f821b328f0b25eada1a7789e73d5b19b8ba1fc3146bcb080a67aa68ece`. This result is **provisional and superseded** by the layout fix below.
- **Layout defect found in that run's Windows screenshot (root visual review).**
  - **Symptom:** in the 1008×681 viewport at 100 ns/div, the timing panel grew to about 920 px (labels plus the 840 px canvas), leaving the circuit about 87 px, mostly clipped even after Fit To Window.
  - **Cause:** the `.panel` flex item had `min-width: auto`, so its intrinsic minimum (the waveform width) overrode `flex-basis: clamp(420px, 40vw, 760px)`.
  - **Fix**, in `src/renderer/src/styles/TimingPanel.module.css`, the only production change: `min-width: 0` on `.panel` and `.scroll`. The waveform now scrolls inside the bounded panel.
  - **New smoke checks** in `scripts/ci/windows-installer-smoke.mjs` (`pageLayout`, `layoutProblems`, `checkLayout`, `readExactVectors`). They run at the real window size and at emulated 1366×768 and 1008×681 viewports. They assert:
    - panel width ≤ clamp(420, 40vw, 760) + 1
    - circuit + panel fit the viewport
    - the circuit gets the rest of the width, at least half when the viewport is ≥ 1000 px
    - the circuit canvas has resized to its container
    - 100 ns/div scrolls inside the panel, and Fit run needs no scrolling
  - Then, per viewport: Fit To Window and a screenshot. Finally, Fit run must read the exact A–D and F midpoint vectors.
  - **Writer headless dry run** (chrome-headless-shell, built renderer, stubbed IPC). Before the fix, the check fails: `timing panel 921px wider than 513px; circuit only 359px of 1280px`. After the fix:

    | Viewport | Panel | Circuit |
    |---|---|---|
    | 1280 (window) | 512 | 768 |
    | 1366×768 | 546 | 820 |
    | 1008×681 | 420 | 588 |

    At 1008 px, 100 ns/div scrolls (scrollWidth 840 > clientWidth 339). Fit run gives plot 335 ≤ 339, with exact vectors.
  - **Other writer checks:** `npm run build` exit 0; `node --check` OK.
  - **Next:** the root's PR #13 checks and visual review verify the fixed candidate. The exact final run, commit and installer hash go in the root's delivered acceptance manifest and the PR body. The guide's build-record table stays blank so it can be reused.

---

Earlier task history follows (task_bce0b0c0cb8a and its fix-ups).

## Objective

Carry out the SimUaid portions of ECE 3441 Lab 3 for the assigned expression
`F = BCD + ABCD' + C'D + AB'D`, and fix the repo gaps this exposed:

- no Boolean analysis
- timing scale capped at 20 ns/div, with oversized canvases
- timing print without labels

The acceptance write-up is `docs/LAB3_ACCEPTANCE.md`.

## Base

- Worktree `/Users/felipe/orca/workspaces/SimUAid-Modernized/flatback`
- Branch `dreamingofu/lab3-simuaid-logic-sim`
- Base/HEAD `9d2aaa667ac334169229c5e51dea1b8cb4d37224`
- All changes are uncommitted (no commit, no push).

## Changed paths

New:

- `src/renderer/src/boolean/expression.ts`: parser (no eval), truth table, standard SOP, exact minimum SOP, report text.
- `src/renderer/src/boolean/sopCircuit.ts`: production gate-circuit and stimulus builder.
- `src/renderer/src/boolean/expression.test.ts`, `sopCircuit.test.ts`, `lab3Acceptance.test.ts`
- `src/renderer/src/components/BooleanDialog.tsx`: the Tools → Boolean Expression / Truth Table… dialog.
- `src/renderer/src/rendering/timing.ts` and `timing.test.ts`: shared timing drawing, scale/fit layout, run extent, canvas bounds.
- `src/renderer/src/rendering/recordingContext.ts`: test-only fake 2D context.
- `src/renderer/src/printing/print.test.ts`: timing print image size and extent.
- `samples/lab3-assigned.ckt`: generated by the production builder.
- `docs/LAB3_ACCEPTANCE.md`, `docs/LAB3_HANDOFF.md`

Modified:

- `src/shared/menu.ts`: new Tools menu with the `tools.boolean` command.
- `src/renderer/src/commands.ts`: the command, plus a quick-start help line.
- `src/renderer/src/components/DialogHost.tsx`
- `src/renderer/src/components/Modal.tsx`: optional `wide` layout.
- `src/renderer/src/components/TimingPanel.tsx`
- `src/renderer/src/components/PrintRoot.tsx`, `PrintPreviewDialog.tsx`: print jobs with no image, notes and a table.
- `src/renderer/src/printing/print.ts`: `renderTimingImage`.
- `src/renderer/src/store/circuitStore.ts`: `openGeneratedCircuit`, the `PrintJob` type, `TimingScale` (`number | 'fit'`, clamped 1–1000).
- `src/renderer/src/store/circuitStore.test.ts`
- Styles: `Modal.module.css`, `TimingPanel.module.css`, `index.css`
- `README.md`: one workflow line.
- `package-lock.json`: audit gate, see below.

## Choices

- **Analysis:** inputs are 1–4 single letters, case-insensitive, first is MSB.
  - Grammar: adjacency or `*`/`·`/`&` is AND; `+` or `|` is OR; postfix `'` `’` `′` `‘` `ʼ` is NOT; `()` or `[]` group, and each group must close with its own glyph; 0 and 1 are constants; an optional `NAME =` prefix names the output.
  - Bounds: 512 characters, 16 nesting levels, 400 operations.
  - Errors give column numbers.
  - The minimizer enumerates every cube to find prime implicants, then runs branch-and-bound exact cover. Cost is terms, then literals. Ties are broken by the sorted term key: variables in order, true before complemented.
- **Circuit:** inputs are stacked rows on the left. The last input's rails are leftmost, so row wires never cross rails.
  - A NOT sits in a row only when a complement is used.
  - AND gates sit beside the rows once their rails exist. Single-literal terms pass straight through the gate column on a wire.
  - OR tree: OR2–OR5; 6–8 terms use two levels. Wires feeding the OR use separate channels, so they never cross each other.
  - True rails step down to probes A..D below the gates; F has its own probe.
  - Everything is drawn wires; only the input sources carry pin labels. All four inputs are always kept.
  - Lab circuit footprint is about 700 × 780 world px.
- **Document safety:** there is no store undo in this app. Create circuit uses `openGeneratedCircuit`:
  1. Runs `confirmDiscardIfDirty` (Save / Don't Save / Cancel).
  2. Aborts if the document generation, netlist or switch values changed while the prompt was open.
  3. Otherwise loads the circuit as untitled, marks it dirty, applies Fit to Window and sets 100 ns/div.
- **Timing:**
  - Scales: Fit run, plus 1, 2, 5, 10, 20, 50, 100, 200, 500 and 1000 ns/div.
  - Canvas caps: 16,000 CSS px wide. `boundedCanvasSize` lowers the device-pixel ratio, with no minimum, until each backing-store side is at most 32,000 px and the area at most 16 MP. Both the panel and the print image use it. A scale that would exceed the width cap is disabled; if it is already selected, the panel falls back to the finest scale that fits and labels it "(finest that fits this run)".
  - `timingExtent` separates two times. The axis runs to the horizon: `max(configured simulation time, simulated time)`. Traces, the `end N ns` marker and the print stop at the simulated time: `max(engine time, latest sample)`. A partial Step run is no longer drawn out to 1600 ns. A full Go still ends at 1600 ns. The first tick reads "0 ns".
  - Panel width is now `clamp(420px, 40vw, 760px)`.
  - Print redraws the simulated run at page width (960 px, 64 px label column), with A/B/C/D/F names, ns ticks and the endpoint. The title includes the range and ns/div.
- **Copy report:** uses a temporary textarea and `execCommand('copy')`. The main process denies all permission checks, so `navigator.clipboard` would fail. Print report goes through the existing print preview and print pipeline.
- **Audit:** only the lockfile changed, and only to patch releases of the flagged packages:
  - brace-expansion 1.1.18→1.1.21 ×3, 2.1.4→2.1.7 ×2, 5.0.9→5.0.12
  - fast-uri 3.1.7→3.1.8

  Resolved URLs and integrity values come from `npm view`. `npm audit fix` refused to run (peer conflict between `@vitejs/plugin-react` 4 and vite 8), and `--force` was not used.

  The writer did not reinstall `node_modules`. The root later ran a fresh `npm ci --legacy-peer-deps` (exit 0), so the installed dependencies now match the patched lockfile.

## Follow-up fixes (task_9af80f53e9ca, from root review)

1. **Mismatched brackets.** Group tokens now keep their glyph, and the parser requires the matching closer. `[A+B)`, `(A+B]`, `([A+B)]` and `[(A+B])` are rejected with a column-numbered "does not match … use …" message. Unmatched or missing errors and the empty-group error name the actual glyph. Valid nested mixes such as `[(A + B)C]' + D` and `([A + B][C + D])'` still parse.
2. **Partial runs.** The panel uses `timingExtent`, so traces, the end marker and the print stop at the actually simulated end, while the axis keeps the configured horizon. Printing before any run reports "Nothing to print".
3. **Canvas bounds.** `boundedPixelRatio` and its 0.25 floor are replaced by `boundedCanvasSize`, which floors the result so rounding cannot exceed the bounds. `renderTimingImage` no longer hard-codes 2x; it uses `boundedCanvasSize(width, height, 2)`. A 5,000-probe diagram (150,022 px tall) now stays within 32k per side and 16 MP.

Focused regression tests:

- `expression.test.ts`: 8 mismatch/unmatched/empty cases, plus 2 valid nested cases.
- `timing.test.ts`:
  - `timingExtent` cases: partial, full, overrun, not run
  - a recorded-stroke test showing traces end at 400 px for an 800 ns partial run versus 800 px for a full 1600 ns run, on a 1600 ns axis
  - `boundedCanvasSize` for normal, wide, 5,000-probe, wide 5,000-probe and printed 5,000-probe cases: both sides ≤ 32,000, area ≤ 16 MP
- `print.test.ts`:
  - a normal print is 1920×344
  - a 5,000-probe print stays within bounds
  - a partial-run print reports `endNs` 800

Writer ran focused checks only:

| Check | Result |
|---|---|
| `npx vitest run src/renderer/src/rendering src/renderer/src/printing src/renderer/src/boolean/expression` | 3 files, 69 tests passed |
| `npm run typecheck` | exit 0 |

Root owns the dependency sync and the final full checks.

## Endpoint label fix (task_f52068065ca0, from root GUI QA)

**Problem.** `drawTimingDiagram` always right-aligned the `end N ns` label at the marker's x − 2. On a fitted 1600 ns axis, a partial Step run that ends at 100 ns puts the marker near x = 26. The label then started off the left edge of the canvas and was clipped.

**Fix.**
- The label is drawn left-aligned at a computed left edge.
- It goes left of the marker when it fits there.
- Otherwise it goes right of the marker, clamped inside the plot.
- It is never placed before the label column (64 px in print) or past the plot's right edge.
- Full runs render as before: the label sits left of the 1600 ns marker.

No other code changed.

**Regression test.** `recordingContext` now records each `fillText` extent (6 px per character, honouring `textAlign`). `timing.test.ts` checks:
- early ends (100 ns and 1 ns in the panel; 100 ns in print with the label column) stay inside the plot and to the right of the marker
- full 1600 ns runs keep the label left of the marker, inside the plot

Writer focused checks, run after the root's `npm ci --legacy-peer-deps` install-done message:

| Check | Result |
|---|---|
| `npx vitest run src/renderer/src/rendering src/renderer/src/printing` | 2 files, 20 tests passed |
| `tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| Mutation check: old placement restored temporarily | the 3 early-end cases fail; code restored, 17/17 timing tests pass |

Root also verified, in its QA:
- the Copy report payload (with a clipboard stub)
- Print report with 16 rows
- the remembered expression
- the malformed `A+` error
- the malformed-bracket error
- the partial Step print endpoint at 100 ns

## Writer checks (worker, this worktree, before the follow-up)

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 34 files: 33 passed, 1 skipped; 14652 tests passed, 4 skipped (baseline was 14560) |
| `npm run build` | ✓ built |
| `npm audit --audit-level=high` | exit 0, "found 0 vulnerabilities" |

Other evidence:

- The Lab 3 acceptance test passes all 16 midpoint rows and the 1600 ns endpoint, through the real `deserializeNetlist` and `Simulator`.
- Engine waveform for F: `0:0 102:1 202:0 502:1 602:0 702:1 802:0 902:1 1002:0 1102:1 1202:0 1302:1`. Midpoint sequence: `0100010101010111`.
- The builder simulates correctly for:
  - all 256 functions of 3 inputs
  - 67 four-input functions, including XOR4 (8 terms, two-level OR)
  - the constants 0 and 1
  - single-literal cases

  None of these produce overlapping parts.
- The minimizer matches brute force on all 256 three-input functions and on 44 hard or random four-input functions. It produces an exact cover for all 65,536 four-input functions.

The layout was sanity-checked from an SVG dump; this is not app rendering.

## Root acceptance

Already passed (root rendered QA, reported to the writer; evidence in `/tmp/simuaid-lab3-qa` and `~/Downloads/SimUAid-Lab3-results`):

- At 1280×900 and 1366×768, Fit shows the full circuit and all 5 traces.
- The analysis shows all 16 rows.
- Save/New/Open keeps the same 15 parts and 23 wires.
- Cancel preserves the dirty document.
- Schematic and timing print images are readable.

Final root acceptance (reported to the writer; the writer did not run these):

- Code review accepted all changes, including the final endpoint-label clamp.
- Fresh `npm ci --legacy-peer-deps`: exit 0.

| Check (root) | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 34 files passed, 1 skipped; 14677 tests passed, 4 skipped |
| `npm run build` | exit 0 |
| `npm audit --audit-level=high` | 0 vulnerabilities |

Real built Electron smoke test, with main, preload and renderer IPC. The window was hidden, dialog choices were automated, and the console showed no errors. Steps:
1. Open the sample, then Go to 1600 ns.
2. Save As to real disk, then New.
3. Reopen the saved file, then Go to 1600 ns again.

Result: the same 15 components and 23 wire geometries survived. Net ids were rebuilt correctly on load, which is normal. Evidence: `/tmp/simuaid-lab3-qa/electron-smoke.json`.

Independent oracle:
- 512/512 cases agree.
- The final sample matches 16/16 midpoints plus the 1600 ns endpoint.
- Evidence: `/tmp/simuaid-lab3-independent/final-sample.json`.

Root-generated report: `~/Downloads/SimUAid-Lab3-results/ECE3441_Lab3_SimUAid_Test.pdf`. The circuit is `samples/lab3-assigned.ckt`.

Boundaries (not validated, not claimed):
- signed installers
- Windows builds
- campus or lab-machine package deployment

Code-signing configuration was not touched.

## Next action (historical)

Superseded; see **Current state** at the top.
