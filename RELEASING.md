# SimUaid releases

Installers are written to `dist/`:

| Platform | File |
| --- | --- |
| Windows x64 | `SimUaid-0.1.0-windows-x64-setup.exe` |
| macOS Intel and Apple Silicon | `SimUaid-0.1.0-mac-universal.dmg` |

The version in each filename comes from `package.json`.

## Build locally

Use Node.js 22. Install dependencies with `npm ci --legacy-peer-deps`, then run:

```sh
npm run typecheck
npm test
npm run build:mac  # Run on macOS
npm run build:win  # Prefer Windows; cross-building may require additional tools
```

These commands build installers without publishing. Build outputs are ignored by
Git; attach the `.exe` and `.dmg` to a GitHub Release instead of committing them.

## Download builds from GitHub Actions

After pushing this setup to GitHub, open **Actions → Release → Run workflow**.
When both jobs finish, download `SimUaid-macOS` and `SimUaid-Windows` from the
run's **Artifacts** section. Unzip them to get the installers. Manual runs on
branches do not create releases.

## Create a release

1. Commit and push the source and release configuration you want to distribute.
2. Create and push a tag matching `package.json` (currently `v0.1.0`):

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. Wait for **Actions → Release** to finish. It tests and builds both platforms,
   then creates a draft release with both installers and `SHA256SUMS.txt`.
4. Open **Releases**, review the draft, and click **Publish release** to make
   downloads public.

For later releases, update the version with `npm version patch --no-git-tag-version`,
commit both package files, push, and tag the new version. A rerun may replace
draft assets but will refuse to overwrite assets on a published release.

You can also create a release manually through GitHub's **Releases → Draft a new
release** page and upload the locally built installers and checksums.

## Signing

Current builds are unsigned and the macOS build is not notarized. Windows may
show SmartScreen warnings. On macOS, users may need to approve the app through
**System Settings → Privacy & Security** after attempting to open it. Only
approve an app if you trust its source. Managed computers may block unsigned
apps entirely.

For signed distribution, configure Windows signing credentials and an Apple
Developer ID certificate plus notarization credentials. The macOS configuration
currently sets `identity: null`; change it when adding Apple signing.
