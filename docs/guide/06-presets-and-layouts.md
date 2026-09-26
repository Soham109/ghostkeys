---
title: Presets and layouts
description: Ready-made bindings and ready-made zone arrangements, and how they fit together.
order: 6
---

Layouts and presets solve two different problems. A layout gives you zones without drawing them. A preset gives you a binding without building one.

## Layouts

A layout is the starting set of zones for your Mac model: which surfaces have zones, where they sit, and how big they are. Ghostkeys picks one automatically based on the model you confirmed in setup (see [Zones](03-zones.md) for the per-model table), so you start with a sensible arrangement rather than a blank case.

A layout is just a starting point. Redraw, resize, rename, add, or remove any zone at any time; there's no separate "layout mode" to leave first.

## Presets

A preset is a ready-made action, already labeled and categorized, that you can drop onto a gesture instead of configuring the action fields yourself. Presets are grouped by category:

- **Media**: play/pause, next/previous track, volume, brightness, muting a call in Zoom or Google Meet.
- **Window**: snap left/right/top/bottom, fill the screen, center, move to the next display, minimize, toggle full screen.
- **System**: lock screen, sleep display, screenshots, Do Not Disturb, Mission Control, Launchpad, show desktop, Spotlight, the character viewer.
- **Apps**: switch, hide, or quit the frontmost app, or open a specific app like Mail, Calendar, Notes, or Terminal.
- **Excel and Sheets**: AutoSum, fill down, fill right, paste values only, insert/delete row, toggle an absolute reference, next/previous sheet, toggle filter.
- **Browser**: new tab, close tab, reopen closed tab, next/previous tab, back, forward, reload, focus the address bar.
- **Dev**: VS Code's command palette and terminal toggle, Xcode run and build, toggling a line comment, clearing the Terminal, save all.
- **Writing**: undo, redo, copy, paste, paste without formatting, bold, italic, start dictation, insert today's date, a text sign-off, select the current line.

Some presets are suggested only when they make sense for a particular app. An Excel preset shows up as a suggestion when you're binding something for Excel; the Zoom mute preset shows up for Zoom. You can still apply any preset to any app scope by hand.

The preset library is actively growing. If the shortcut you want isn't in there yet, build it yourself as a keyboard shortcut, a Shortcut, or a small macro (see [Actions](05-actions.md)), and it'll behave exactly like a built-in preset once it's bound.
