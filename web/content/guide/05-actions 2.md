---
title: Actions
description: Every action kind, with examples, macros, integrations, and per-app layers.
order: 5
---

An action is what runs when a gesture fires. You pick a gesture, a zone (or two, for a sequence), optional modifier keys, optionally an app to scope it to, and then the action itself.

## Action kinds

**Keyboard shortcut.** Sends a key combination, exactly as if you'd pressed it. Example: bind a double tap on the left palm rest, while in Excel, to Command-Shift-T for AutoSum. Needs Accessibility.

**Volume.** Steps the output volume up or down by a percentage. Example: single tap on the right grille, volume up 6%. Works without any permission.

**Mute.** Toggles output mute. Works without any permission.

**Media control.** Play/pause, next track, or previous track, sent as the same system media keys your keyboard's media row sends. Example: double tap on the right palm rest, play/pause. Needs Accessibility.

**Brightness.** Steps screen brightness up or down. Needs Accessibility.

**Open app, file, or link.** Opens an application by name, a file or folder path, or a URL. Example: tap the top strip to open Spotify, or open a specific project folder.

**Shell command.** Runs a command through your shell. It always has a 10-second limit and Ghostkeys refuses any command that mentions `sudo`, so it can never ask for elevated access through this path. Example: copy the current git status of your home folder to the clipboard.

**AppleScript.** Runs a script you write. Ghostkeys refuses a script that mentions `sudo` or asks for administrator privileges. The first time a script controls a specific app (for example Music or Finder), macOS will ask you to approve Automation access for that app.

**Run a Shortcut.** Runs a macOS Shortcut by name. Build anything your Shortcut supports and trigger it with a tap.

**Type text.** Types out a fixed string, letter by letter, as if you'd typed it. Example: a tap that types a sign-off, or a repeated boilerplate line. Needs Accessibility. Capped at 5,000 characters.

**Copy to clipboard.** Puts a fixed string on the clipboard, without typing anything.

**Arrange window.** Moves or resizes the frontmost window: left half, right half, top half, bottom half, fill the screen, center, move to the next display, minimize, or toggle full screen. Needs Accessibility, and needs the frontmost app to actually have a focused window.

**Control app.** Acts on the frontmost app: hide it, quit it, or switch to the next or previous app (like Command-Tab). Quitting is permanent, so Ghostkeys makes you confirm before you can bind it, and it will never let you bind quitting Finder or quitting Ghostkeys itself.

**System command.** Lock the screen, sleep the display, take a screenshot (of the whole screen or a selected area), toggle Do Not Disturb, open Mission Control or Launchpad, or show the desktop. None of these ever need admin rights. Two notes: a screenshot action will trigger macOS's own Screen Recording permission prompt the first time you use it, and lands wherever your Mac normally saves screenshots; toggling Do Not Disturb depends on you having a Shortcut named something like "Toggle Do Not Disturb" already set up, since Apple doesn't expose a direct toggle to third-party apps.

## Macros

A macro runs a list of the actions above, in order, on their own. Each step can carry a delay to wait before it runs. A macro stops at the first step that fails, so a broken step later on doesn't leave things half-done. Macros can't contain another macro, and are capped at 50 steps and 30 seconds total, which is generous for anything you'd actually want to trigger with a tap.

Example: a "select current line" macro that sends Command-Left, waits briefly, then sends Command-Shift-Right.

## Integrations (in development)

Ghostkeys is building a set of app-aware commands that go beyond a single keystroke, things like wrapping a spreadsheet formula in `IFERROR`, toggling an absolute cell reference, or inserting an `XLOOKUP` in Excel. These will need Automation permission for the specific app they control, granted the first time you use one, the same way an AppleScript action does. This part isn't shipped yet; check back as it lands.

## Per-app layers

Every binding can be scoped to a specific app, or left as a wildcard that applies everywhere. If you have a wildcard binding and an app-specific binding for the exact same gesture, zone, and modifiers, the app-specific one wins whenever that app is frontmost; the wildcard is the fallback everywhere else.

This is how the same tap can mean two different things depending on what you're doing: a double tap on the left palm rest can be AutoSum in Excel and something else entirely (or nothing) in every other app. You don't need a different zone for this, just a different app scope on the binding.
