# Signing and notarizing Ghostkeys

Reference steps for when there is a paid Apple Developer ID to sign with. `app/electron-builder.yml`
currently ships with `identity: null` and `hardenedRuntime: false` (ad-hoc, unsigned, local-only
builds), which is correct for now — nothing below needs to happen until that changes. Ghostkeys is
two signed artifacts, not one: the `ghostkeysd` daemon binary, and the `Ghostkeys.app` bundle that
embeds it.

## 0. One-time setup

1. Enroll in the Apple Developer Program and create a **Developer ID Application** certificate in
   Xcode (Settings > Accounts > Manage Certificates) or via the Developer portal. It must land in
   your login keychain as `Developer ID Application: <Your Name/Org> (TEAMID)`.
2. Create an app-specific password for notarization: appleid.apple.com > Sign-In and Security >
   App-Specific Passwords.
3. Store notarization credentials once, so `notarytool` doesn't need them on every call:
   ```
   xcrun notarytool store-credentials "ghostkeys-notary" \
     --apple-id "you@example.com" \
     --team-id "TEAMID" \
     --password "the-app-specific-password"
   ```

## 1. Build

```
packaging/build-daemon.sh   # -> packaging/build/ghostkeysd
packaging/build-app.sh      # -> app/release/mac-arm64/Ghostkeys.app
```

## 2. Sign the daemon binary first

The daemon is signed on its own before it's embedded, because electron-builder's `--dir` target
does not re-sign `extraResources` — whatever signature (or lack of one) the binary has when it's
copied in is what ships.

```
codesign --force --options runtime --timestamp \
  --entitlements packaging/entitlements.plist \
  --sign "Developer ID Application: <Your Name/Org> (TEAMID)" \
  packaging/build/ghostkeysd

codesign --verify --verbose=2 packaging/build/ghostkeysd
```

Then re-run `packaging/build-app.sh` (or just re-copy the signed binary into the already-built
`.app`'s `Contents/Resources/ghostkeysd`) so the signed binary is the one that gets embedded.

## 3. Sign the app bundle

Update `app/electron-builder.yml`'s `mac.identity` to your Developer ID (or pass it via
`packaging/electron-builder.icons.yml`, which is deep-merged over it, instead of editing app/
directly) and set `hardenedRuntime: true`. Point `mac.entitlements` /
`mac.entitlementsInherit` at `packaging/entitlements.plist`. electron-builder will then sign
`Ghostkeys.app` itself as part of `packaging/build-app.sh`.

To sign by hand instead (e.g. while iterating without touching the electron-builder config):

```
codesign --force --deep --options runtime --timestamp \
  --entitlements packaging/entitlements.plist \
  --sign "Developer ID Application: <Your Name/Org> (TEAMID)" \
  app/release/mac-arm64/Ghostkeys.app

codesign --verify --deep --strict --verbose=2 app/release/mac-arm64/Ghostkeys.app
spctl --assess --type execute --verbose app/release/mac-arm64/Ghostkeys.app   # expect "rejected" until stapled
```

## 4. Build and sign the DMG

```
packaging/make-dmg.sh app/release/mac-arm64/Ghostkeys.app   # -> packaging/build/Ghostkeys.dmg

codesign --force --sign "Developer ID Application: <Your Name/Org> (TEAMID)" \
  packaging/build/Ghostkeys.dmg
```

## 5. Notarize

```
xcrun notarytool submit packaging/build/Ghostkeys.dmg \
  --keychain-profile "ghostkeys-notary" \
  --wait
```

If it comes back `Invalid` instead of `Accepted`, pull the reason before retrying:

```
xcrun notarytool log <submission-id> --keychain-profile "ghostkeys-notary"
```

Common causes: the daemon binary wasn't signed before being embedded (step 2 skipped), a
`com.apple.security.*` entitlement is requested that the binary doesn't actually use (Apple
rejects entitlements it can't justify against the binary's linked frameworks), or hardened
runtime wasn't enabled on every executable in the bundle.

## 6. Staple and verify

```
xcrun stapler staple packaging/build/Ghostkeys.dmg
xcrun stapler validate packaging/build/Ghostkeys.dmg
spctl --assess --type open --context context:primary-signature -v packaging/build/Ghostkeys.dmg
```

A fresh Mac (or `xattr -d com.apple.quarantine` on a copy) should now open the DMG and mount the
app without a Gatekeeper warning.

## Notes

- `packaging/entitlements.plist` intentionally does not request `com.apple.security.app-sandbox`.
  Ghostkeys does not sandbox: the daemon needs raw IOKit sensor access and to post synthetic
  input events, neither of which the sandbox allows. Hardened Runtime + notarization is the
  Gatekeeper story instead of the sandbox.
- If `GhostkeysAcoustics` or `GhostkeysVision` are ever linked into the shipped daemon (today
  they're separate optional targets, not dependencies of the `ghostkeysd` product), keep the
  `audio-input` / `camera` entitlements. If they're dropped, drop the entitlements too —
  notarization scrutinizes entitlements that don't match what the binary actually calls.
- Re-run `packaging/build-daemon.sh` whenever `daemon/` changes and re-sign before re-packaging;
  a stale unsigned or differently-signed `ghostkeysd` inside a signed `.app` will fail
  `codesign --verify --deep`.
