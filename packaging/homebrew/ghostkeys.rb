# Homebrew Cask template for Ghostkeys.
#
# This is not published to homebrew-cask yet — there's no signed, notarized release to point at.
# Fill in `version`/`sha256`/`url` once packaging/make-dmg.sh has produced a real, notarized
# Ghostkeys.dmg attached to a GitHub release, then this can be submitted to
# https://github.com/Homebrew/homebrew-cask (or hosted in a personal tap first with
# `brew tap-new` while iterating).
#
# Local test once filled in:
#   brew install --cask ./packaging/homebrew/ghostkeys.rb

cask "ghostkeys" do
  version "0.1.0"
  sha256 :no_check # replace with the real sha256 of Ghostkeys.dmg before publishing

  url "https://github.com/<org>/ghostkeys/releases/download/v#{version}/Ghostkeys.dmg"
  name "Ghostkeys"
  desc "Turns the blank parts of your MacBook into controls, using the sensors already inside it"
  homepage "https://ghostkeys.com"

  # Ghostkeys ships arm64-only today (see app/electron-builder.yml, mac.target.arch).
  depends_on macos: ">= :sonoma"
  depends_on arch: :arm64

  app "Ghostkeys.app"

  zap trash: [
    "~/Library/Application Support/Ghostkeys",
    "~/Library/Caches/com.ghostkeys.app",
    "~/Library/HTTPStorages/com.ghostkeys.app*",
    "~/Library/Logs/Ghostkeys",
    "~/Library/Preferences/com.ghostkeys.app.plist",
    "~/Library/Saved Application State/com.ghostkeys.app.savedState",
  ]

  caveats <<~EOS
    Ghostkeys reads MacBook sensors and posts synthetic keyboard/media events, so macOS will
    ask for a few permissions the first time it runs. These are granted by hand in System
    Settings — Homebrew and this cask cannot do it for you:

      - Accessibility          (System Settings > Privacy & Security > Accessibility)
      - Input Monitoring       (System Settings > Privacy & Security > Input Monitoring)
      - Microphone             (only if you enable the acoustics/sound mode)
      - Camera                 (only if you enable the M4/M5 Desk View hand-tracking add-on)

    Ghostkeys is not sandboxed; see packaging/notarize.md and packaging/entitlements.plist in
    the source repo for exactly what it requests and why.
  EOS
end
