# Notarizing Mac builds

A Developer ID signature tells macOS who built Apex Deck. Notarization is
Apple's scan on top of that: with it, a copy downloaded on another Mac opens
without the "cannot be verified" prompt or a trip to **Open Anyway**.

The packaging scripts notarize on their own when two things are true:

1. The build is signed with a **Developer ID Application** identity (see
   [desktop.md](desktop.md); ad hoc builds are never notarized).
2. Apple credentials are set in the environment, as below.

Otherwise they print `skipping notarization: <reason>` and build as before, so
local development builds are unchanged.

| What is built | Command | What gets notarized |
| --- | --- | --- |
| Desktop app | `npm run desktop:package` | `Apex Deck.app`, stapled (by electron-builder) |
| Desktop disk image | `npm run desktop:dmg` | the app, then `Apex-Deck_<version>_<arch>.dmg`, both stapled |
| Standalone CLI archive | `node ../scripts/package-cli-mac.mjs` from `release/` | `apex`, `apex-daemon`, `apex-provenance` |

The CLI binaries are submitted as a zip of the exact signed files that go into
the `.tar.gz`. Bare binaries cannot carry a stapled ticket, so Gatekeeper
checks them online the first time they run.

`release/Apex-Deck-upgrade.pkg` is still built with `pkgbuild` and no installer
signature, so it is not notarized. The app inside it is.

## One-time setup on the build Mac

You need Xcode or its command line tools (`xcrun notarytool` comes with them)
and your Developer ID Application certificate in the login keychain.

The recommended setup keeps every secret in the keychain:

1. Make an app-specific password at [account.apple.com](https://account.apple.com)
   → Sign-In and Security → App-Specific Passwords.
2. Store it in a notarytool profile. It prompts for the password, so it never
   lands in shell history:

   ```sh
   xcrun notarytool store-credentials apex-deck-notary \
     --apple-id "<your Apple ID>" --team-id "<your 10-character team ID>"
   ```

3. Tell the build which profile to use, for example in `~/.zshrc`:

   ```sh
   export APPLE_KEYCHAIN_PROFILE=apex-deck-notary
   ```

The scripts also accept the other two sets electron-builder understands. Use
one set only; a partial set stops the build with the names of the missing
variables.

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. The password is
  passed to `notarytool` on its command line, so the profile above is safer.
- `APPLE_API_KEY` (path to an App Store Connect `.p8` key file),
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Good for CI.

If more than one set is present, the Apple ID set wins, then the API key, then
the keychain profile, the same order electron-builder uses for the app.

Never commit any of these values or the `.p8` file.

## Switches

- `APEX_DECK_NOTARIZE=0` skips notarization even when credentials are set.
- `APEX_DECK_NOTARIZE=1` makes a missing credential set or an ad hoc identity
  an error, for release builds that must not ship un-notarized.

## Check a build

Apple usually answers within a few minutes; the build waits for it. A rejected
submission fails the build and prints Apple's log for that submission.

```sh
xcrun stapler validate "release/mac-arm64/Apex Deck.app"
spctl -a -vvv -t exec "release/mac-arm64/Apex Deck.app"
xcrun stapler validate release/Apex-Deck_*_arm64.dmg
spctl -a -vvv -t open --context context:primary-signature release/Apex-Deck_*_arm64.dmg
```

`spctl` should report `source=Notarized Developer ID`.
