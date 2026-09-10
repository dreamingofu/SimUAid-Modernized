# SimUaid releases

Installers are written to `dist/`:

| Platform | File |
| --- | --- |
| Windows x64 | `SimUaid-0.1.3-rc.1-windows-x64-setup.exe` |
| macOS Intel and Apple Silicon | `SimUaid-0.1.3-rc.1-mac-universal.dmg` |

The version in each filename comes from `package.json`.

## Build locally

Use Node.js 22. Install dependencies with `npm ci --legacy-peer-deps`, then run:

```sh
npm run typecheck
npm test
npm run build:mac  # Run on macOS with a Developer ID Application certificate
npm run build:win  # Prefer Windows; cross-building may require additional tools
```

These commands build installers without publishing. Local macOS builds are signed,
but are not notarized; use the GitHub workflow for distributable macOS installers. Build outputs are ignored by
Git; attach the `.exe` and `.dmg` to a GitHub Release instead of committing them.

## Download builds from GitHub Actions

After pushing this setup to GitHub, open **Actions → Release → Run workflow**.
Configure the macOS credentials below before running the workflow.
When both jobs finish, download `SimUaid-macOS` and `SimUaid-Windows` from the
run's **Artifacts** section. Unzip them to get the installers. Manual runs on
branches do not create releases.

## Create a release

1. Commit and push the source and release configuration you want to distribute.
2. Create and push a tag matching `package.json` (currently `v0.1.3-rc.1`):

   ```sh
   git tag v0.1.3-rc.1
   git push origin v0.1.3-rc.1
   ```

3. Wait for **Actions → Release** to finish. It tests and builds both platforms,
   signs and notarizes the macOS installer, verifies its ticket and Gatekeeper
   assessment, then creates a draft release with both installers and `SHA256SUMS.txt`.
4. Open **Releases**, review the draft, and click **Publish release** to make
   downloads public.

For later releases, update the version with `npm version patch --no-git-tag-version`,
commit both package files, push, and tag the new version. A rerun may replace
draft assets but will refuse to overwrite assets on a published release.

You can also create a release manually through GitHub's **Releases → Draft a new
release** page and upload the locally built installers and checksums.

## macOS signing and notarization setup

The release workflow requires a **Developer ID Application** certificate from
an active Apple Developer Program team. An Apple Development or Apple Distribution
certificate cannot replace it for this GitHub distribution workflow.

1. In **Xcode → Settings → Accounts**, select your paid team and open
   **Manage Certificates**. Click **+ → Developer ID Application**. The account
   holder may need to create it if your role does not permit this.
2. Control-click the certificate and choose **Export Certificate**. Save the
   `.p12` outside this repository with a strong export password. It includes the
   private signing key; do not commit it or paste it into chat.
3. At [account.apple.com](https://account.apple.com/), generate an app-specific
   password under **Sign-In and Security → App-Specific Passwords** for notarization.
4. In the repository's [Actions secrets settings](https://github.com/dreamingofu/SimUAid-Modernized/settings/secrets/actions),
   add these repository secrets:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded contents of the exported `.p12` |
| `CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_ID` | Apple Account email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from step 3, not your normal Apple password |
| `APPLE_TEAM_ID` | Team ID from your Apple Developer membership details |

With GitHub CLI signed in, upload the certificate directly without displaying
its contents (replace the example path):

```sh
base64 -i '/absolute/path/DeveloperID.p12' | gh secret set CSC_LINK --repo dreamingofu/SimUAid-Modernized
```

Enter passwords directly in GitHub's secret fields; do not put them in source,
command-line arguments, issue descriptions, or chat. Credentials are supplied only
to the macOS steps. The Windows build remains unsigned.

Run **Actions → Release → Run workflow** after configuration. The macOS job:

- Rejects missing credentials and refuses unsigned packaging.
- Signs the universal app and DMG using Developer ID and Hardened Runtime.
- Submits the complete DMG to Apple and waits for an `Accepted` response.
- Staples the notarization ticket and checks it with `stapler` and Gatekeeper.
- Uploads the installer only after verification succeeds. Checksums are generated
  after stapling because stapling changes the file.

If Apple rejects a submission, inspect the `macOS-notarization-result` artifact
for the submission ID and retrieve the detailed log using `xcrun notarytool log`
with your notarization credentials. Do not publish a rejected build.

If the step instead fails with a timeout (exit 124, "Timeout of N second(s) was
reached before processing completed"), that is `notarytool --wait` giving up,
not a rejection — Apple's queue is normally under a minute but occasionally
runs long. The submission keeps processing on Apple's side regardless. Check
`notarization-log.txt` in the same artifact for the submission ID and query it
once it likely finished:

```sh
xcrun notarytool info <submission-id> --apple-id ... --password ... --team-id ...
```

If it shows `Accepted`, just re-run the workflow (or re-run only the failed
job) — the timeout is not fatal, it costs a wasted signing pass.

Version 0.1.1 was released unsigned and remains unchanged. Version 0.1.2 is prepared for
the signed release; publish its tag only after the signing workflow passes.
Existing downloads do not become signed automatically. A normal downloaded-app confirmation may still appear
for a notarized app.

References: [Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates),
[Apple notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
