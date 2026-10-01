# Instructor pilot guide — ECE 3441 Lab 3 in SimUaid

This guide is for a small, supervised pilot of the SimUaid parts of ECE 3441
Lab 3 ("The Digital Design Process with SimUAid II"). It covers the software
steps, Parts 1–3. Part 4, the physical breadboard, is unchanged. Where the
handout says LogicAid, students use SimUaid's built-in
**Tools → Boolean Expression / Truth Table…** dialog.

The worked case below uses the assigned expression
`F = BCD + ABCD' + C'D + AB'D`. The full derivation and the simulator evidence
are in [LAB3_ACCEPTANCE.md](LAB3_ACCEPTANCE.md). The reference circuit is
[samples/lab3-assigned.ckt](../samples/lab3-assigned.ckt).

## 1. Identify the exact build

The version number alone is not enough. This candidate reports **0.1.3-rc.1**,
and an earlier release used the same number. Identify the build by commit and
installer hash. Record both before class:

| Item | Record here |
|---|---|
| Source commit (Git SHA) | `________________________` |
| Installer file name | `SimUaid-0.1.3-rc.1-windows-x64-setup.exe` (Windows) or the DMG name (macOS) |
| Installer SHA-256 | `________________________` |
| Where it came from | CI run URL or release page: `________________________` |
| Lab machine OS and version | `________________________` |

Get the SHA-256 on the machine you install from:

- Windows (PowerShell): `Get-FileHash .\SimUaid-0.1.3-rc.1-windows-x64-setup.exe -Algorithm SHA256`
- macOS (Terminal): `shasum -a 256 <file>.dmg`

If the hash does not match the hash published with the build, do not install it.

## 2. Platform status and limits

| Platform | Status for this build |
|---|---|
| macOS | The maintainers ran the built app natively: open the sample, Go to 1600 ns, Save As, New, reopen, Go again. The same 15 parts and 23 wires came back. |
| Windows x64 | **Checked in CI on a GitHub-hosted Windows runner**, not on a campus machine. The check covers: silent per-user install, the Lab 3 workflow driven in the installed app (16-row truth table, Create circuit, Go to 1600 ns, timing waveforms read at each midpoint), checks that the timing panel never squeezes out the circuit at 1008 px and 1366 px widths, same-version reinstall, then uninstall. A copied student circuit and the app's settings must survive. The first run ([36804334226](https://github.com/dreamingofu/SimUAid-Modernized/actions/runs/36804334226)) is **superseded**: review of its screenshot found the timing panel squeezing out the circuit at 1008 px, which is now fixed. For the build you deploy, use the latest passing checks and installer artifact on [PR #13](https://github.com/dreamingofu/SimUAid-Modernized/pull/13). Record its commit and SHA-256 in section 1. |

Limits to keep in mind:

- **The Windows installer is unsigned.** Windows may show a publisher or
  SmartScreen warning. Campus IT must review and approve unsigned software
  under its own policy before the pilot. This guide does not recommend
  bypassing those controls; ask IT.
- **The CI runner is not a campus machine.** It does not test domain policy,
  AppLocker, antivirus, roaming profiles, lab-image restrictions or
  standard-user rights on your lab computers. The preflight below is the check
  for your machines.
- **The CI check reinstalls the same version only.** It does not test upgrading
  from an older SimUaid or rolling back.
- **Saving in the app on Windows is not exercised by CI.** The CI keeps a copy
  of a student circuit next to the install and checks it survives reinstall and
  uninstall, but it does not save or open files through the app. Save and open
  were tested natively on macOS only. The preflight saves and reopens a file on
  your lab machines.
- **No crash recovery.** Unsaved work is lost if the app is killed or the
  computer crashes. Tell students to save often with File → Save.

## 3. Pre-class preflight (about 10 minutes per lab image)

Do this on one machine for each lab image, signed in as a normal student account.

1. Install the build from section 1. Launch SimUaid. The window title reads
   `Untitled — SimUaid`.
2. **Tools → Boolean Expression / Truth Table…**. Leave Inputs as `A B C D`.
   Type `BCD + ABCD' + C'D + AB'D` in Expression.
3. Check the results against section 5:
   - Minterms `F = Σm(1, 5, 7, 9, 11, 13, 14, 15) — 8 of 16`
   - Minimum SOP `F = AD + BD + C'D + ABC (4 terms, 9 literals)`
   - 16 truth-table rows
4. Click **Create circuit…**. The dialog closes and the status bar says
   `Created F = AD + BD + C'D + ABC…`. The title starts with `•`, which means
   the circuit is unsaved.
5. **Simulate → Go**. The status bar shows `Time: 1600 ns`.
6. **Window → Open/Close Timing Diagram**. The panel lists A, B, C, D, F and
   reads `100 ns/div · 0–1600 ns`. Pick **Fit run** in Scale to see the whole
   run.
7. **View → Fit To Window**. The whole circuit is visible.
8. **File → Save As…** into the folder students will use, for example
   Documents. Then **File → New**, **File → Open…** the saved file, and run
   **Simulate → Go** again. Check that the timing diagram matches step 6.
9. Print one page: the timing panel's 🖶 button, then **Print…**. Check that the
   page shows A, B, C, D, F, the ns tick labels and `end 1600 ns`. Use a PDF
   printer if you have no paper printer.
10. Run the two safety checks in section 7. After the malformed-input check,
    type the valid expression `BCD + ABCD' + C'D + AB'D` again. Create circuit
    is enabled only for a valid expression, and the unsaved-work check needs it.
11. Close the app. If you will not keep the install, uninstall it, then confirm
    the file from step 8 is still there.

Write down anything that differs from these steps, using the template in
section 9.

## 4. Classroom activity (15–25 minutes)

Before class, give each student their assigned expression.

| Minutes | Student steps (exact UI) |
|---|---|
| 0–3 | Launch SimUaid. Open **Tools → Boolean Expression / Truth Table…**. Inputs: `A B C D`. Type the expression. Primes are `'` after a letter or `)`; adjacent letters mean AND; `+` means OR. |
| 3–8 | Record the minterm list and count, the standard SOP, the minimum SOP and the truth table. Compare the minimum SOP with your own K-map or algebra (lab questions 1–6). **Copy report** copies them as text; paste them into the write-up. **Print report…** prints them. |
| 8–11 | Click **Create circuit…**. If asked to save the previous circuit, choose **Save** or **Don't Save**. **Cancel** keeps the old circuit and creates nothing. Then **File → Save As…** right away. |
| 11–15 | **Simulate → Go**. **Window → Open/Close Timing Diagram**, Scale **100 ns/div** or **Fit run**. Click the diagram to place the cursor and read times. |
| 15–20 | Read F in the middle of each 100 ns interval and compare it with the truth table (question 10). Print or capture the timing diagram and the schematic: 🖶 in the timing panel, **File → Print…** for the schematic. |
| 20–25 | Optional: build the original, unsimplified expression by hand and look for the brief hazard glitch (section 6). Save again before closing. |

What Create circuit builds:

- One Input Signal each for A, B, C and D. ABCD counts from 0000 at 0 ns to
  1111 at 1500 ns, in 100 ns steps. The run ends at 1600 ns. There is no repeat
  (`R`) row.
- A NOT gate where a complemented input is needed, and AND gates labeled with
  their terms.
- OR gate(s) combining the products. Most functions need one OR gate; some
  four-input functions with many terms (for example, a 4-input XOR) need a
  small tree of OR gates. The worked case uses one OR4.
- Every part is connected by a drawn wire.
- Probes A, B, C, D and F, in that order in the timing diagram.

Students can move, relabel and rewire the parts like any other circuit.

## 5. Expected results for the worked expression

`F = BCD + ABCD' + C'D + AB'D`

- Minterms: `Σm(1, 5, 7, 9, 11, 13, 14, 15)`, 8 minterms. There are
  2⁴ = 16 input combinations.
- Standard SOP:
  `A'B'C'D + A'BC'D + A'BCD + AB'C'D + AB'CD + ABC'D + ABCD' + ABCD`
- Minimum SOP: **`F = AD + BD + C'D + ABC`**. It is unique: the four prime
  implicants are all essential, for minterms 11, 7, 1 and 14.

Expected values at each interval midpoint. Row k is ABCD = k in binary,
applied from 100·k to 100·(k+1) ns.

| Row | ABCD | F | | Row | ABCD | F |
|---:|---|---|---|---:|---|---|
| 0 | 0000 | 0 | | 8 | 1000 | 0 |
| 1 | 0001 | 1 | | 9 | 1001 | 1 |
| 2 | 0010 | 0 | | 10 | 1010 | 0 |
| 3 | 0011 | 0 | | 11 | 1011 | 1 |
| 4 | 0100 | 0 | | 12 | 1100 | 0 |
| 5 | 0101 | 1 | | 13 | 1101 | 1 |
| 6 | 0110 | 0 | | 14 | 1110 | 1 |
| 7 | 0111 | 1 | | 15 | 1111 | 1 |

F read at 50, 150, …, 1550 ns, as one vector: **`0100010101010111`**. At
1600 ns, A = B = C = D = F = 1.

## 6. Gate delays, midpoint sampling and hazards

- Every gate has a 1 ns default delay. In the generated circuit, F changes 2 ns
  after an input change (AND, then OR). The longest path is 3 ns (NOT, AND, OR).
  For example, F rises at 102 ns, not at 100 ns.
- Students should read F in the middle of each interval. A reading taken
  exactly on a 100 ns boundary shows the previous row.
- **Hazards.** Physical gates take time, so a circuit can show a brief wrong
  output while its inputs change. Some functions and gate arrangements produce
  a 1–2 ns glitch at a transition. The maintainers' independent build of the
  *original*, unsimplified network showed a short low glitch at
  1402–1403 ns, where ABCD goes 1101 → 1110. That glitch comes from the delayed
  inverted-input path. The minimum-SOP circuit from Create circuit showed no
  glitch in the reference run. A glitch is real timing behavior, not a
  simulator error. Grade the settled mid-interval values.

## 7. Safety checks to demonstrate (or include in preflight)

- **Malformed input.** In the Boolean dialog, type `A +`. The dialog shows
  `"+" needs a term after it (column 3)`, and Create circuit is disabled. Other
  examples:
  - `(A + B` reports a missing `)`.
  - `[A + B)` reports a bracket mismatch.
  - `~A` is rejected, with a hint to write `A'` instead.
- **Unsaved work is protected.** Make any change so the title shows `•`. Then
  open the Boolean dialog and enter a valid expression; after the
  malformed-input check, retype `BCD + ABCD' + C'D + AB'D`. Click
  **Create circuit…**. The Save / Don't Save /
  Cancel prompt appears. **Cancel** keeps the current circuit unchanged, and the
  status bar says `Create circuit cancelled; the current circuit was kept.`

## 8. Student deliverables and suggested rubric

Deliverables follow the lab handout's questions 1–10. Part 4 is graded
separately. Questions 1 and 3 ask for pictures of the student's own written
expansion and algebra. Copy report and Print report are for checking results
and filling in tables; they do not replace that handwritten work.

| Item | Evidence | Points |
|---|---|---|
| Minterm expansion and count (Q1–2) | Work shown; matches the dialog's Σm list | 15 |
| Algebraic simplification with theorems named (Q3) | Hand work; the dialog only checks the result | 20 |
| Minimum SOP compared with the tool (Q4) | Same function; explains any differing but equivalent form | 10 |
| Truth table and number of combinations (Q5–7) | 16 rows, 2⁴ = 16 | 10 |
| Circuit schematic (Q8) | Labeled inputs A–D and output F; printed or captured | 15 |
| Timing diagram (Q9) | 0–1600 ns at a readable scale (100 ns/div or Fit run), A–D and F labeled | 15 |
| Simulation versus truth table (Q10) | Midpoint values compared for all 16 rows; mismatches or glitches explained using gate delay | 15 |

## 9. Staff issue template

Copy this for each problem, one issue per problem:

```
Build: commit ________  installer SHA-256 ________  OS/version ________
Machine/lab image: ________   Student or staff account: ________
What I did (exact menu path and input):
What I expected:
What happened (exact message text; screenshot if possible):
Reproducible? yes / no / sometimes      Work lost? yes / no
Circuit file attached (if not sensitive): yes / no
```

## 10. Pilot size and stop criteria

Start with one section, or 10–20 students, with the instructor or a TA present.
Stop the pilot and go back to the existing lab workflow if any of these happens:

- Any loss of saved student work, or a file that saved but will not reopen.
- The app gives a wrong analysis or simulation result: minterms, minimum SOP,
  truth table, or a waveform mid-interval value that disagrees with the truth
  table.
- The app crashes or freezes repeatedly on the lab image, or IT cannot approve
  the unsigned installer.
- More than two students in the section cannot finish Parts 1–3 in the
  allotted time because of the software, not the lab content.

After the pilot, record the following and share them with the maintainers and
IT before a wider rollout:
- the build identity from section 1
- the issues filed
- whether the stop criteria were hit

## Related documents

- [LAB3_ACCEPTANCE.md](LAB3_ACCEPTANCE.md): derivation, schedule, simulator evidence, scope.
- [LAB3_HANDOFF.md](LAB3_HANDOFF.md): engineering record, changed files, checks.
- [PRODUCTION_READINESS.md](../PRODUCTION_READINESS.md): institutional acceptance gates.
- CI workflow: [.github/workflows/ci.yml](../.github/workflows/ci.yml); the
  Windows installer smoke test is [scripts/ci/windows-installer-smoke.mjs](../scripts/ci/windows-installer-smoke.mjs).
