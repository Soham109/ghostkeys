# @ghostkeys/cli

`gk`: a terminal client for `ghostkeysd`, built on `@ghostkeys/sdk`.

## Install

```sh
pnpm add -g @ghostkeys/cli
# or, from this repo:
pnpm --dir packages/cli install
pnpm --dir packages/cli build
pnpm --dir packages/cli start -- status
```

Every command takes `-p, --port <port>` to point at a daemon on a non-default port.

## Commands

```
gk status                    daemon version, device, sensors, permissions, paused/calibrated
gk watch                     live colored stream of taps, gestures and actions (ctrl-c to stop)
gk zones list                table of configured zones
gk zones add <id> <name>     add a zone (--surface, --rect x,y,w,h, --color)
gk zones rm <id>             remove a zone (blocked if a binding still references it, unless --force)
gk bind <spec> <action>      add a binding (see "the bind grammar" below)
gk unbind <id>                remove a binding by id
gk bindings                   table of configured bindings
gk export > layout.json       print the current config as JSON
gk import layout.json         validate, diff against the current config, confirm, then apply
gk pause / gk resume          pause or resume the daemon
gk calibrate                  interactive wizard: capture taps per zone, then negatives, then train
gk presets search <query>     search presets/library.json by id, title, category or keyword
gk doctor                     check daemon reachability, sensors, accessibility, and model files
```

### The bind grammar

```
gk bind "<gesture> [zone] [+modifiers] [@app]" <action>
```

- `gesture` is required: `tap`, `double`, `triple`, `sequence`, `rhythm`, `lid_nudge`, `cover`,
  `cover_hold`, `tilt_left`, `tilt_right`.
- `zone` is required for every gesture except the zoneless ones (`lid_nudge`, `cover`, `cover_hold`,
  `tilt_left`, `tilt_right`). `sequence` is the one gesture that takes two zones, written as a single
  comma-separated pair: `left-palm,right-palm`.
- `+modifiers` is optional: `+shift`, `+shift+command`, or `+shift +command` all work.
- `@app` restricts the binding to one bundle id, e.g. `@com.microsoft.Excel`. Omit it for every app.
- `action` is either inline JSON (`'{"kind":"volume","step":6}'`) or a preset id from
  `presets/library.json` (`gk presets search` to find one).

```sh
gk bind "double right-grille" '{"kind":"volume","step":6}'
gk bind "double right-grille +shift @com.microsoft.Excel" xl-autosum
gk bind "sequence left-palm,right-palm" win-max
gk bind cover_hold sys-lock
```

`gk bind` checks that every zone it's given actually exists in the daemon's current config before
writing anything, and asks for confirmation before binding a destructive action (anything that can
quit an app), unless you pass `-y`.

## Development

```sh
pnpm install   # links @ghostkeys/sdk via file:../sdk - build the sdk package first
pnpm build
pnpm test      # grammar, preset search, action resolution, binding construction, config diffing
pnpm typecheck
```

Tests here are unit tests of pure logic (the bind grammar parser, preset search, action resolution,
binding construction, config diffing): fast, no network. End-to-end protocol behavior (reconnect,
request/reply matching, calibration state machine) is covered in `@ghostkeys/sdk`'s own test suite
against an in-process fake daemon.

`gk import` and `gk bind` write to whatever daemon they connect to. Point `-p` at a throwaway/dry-run
daemon, or a fake one, when trying these out; don't run them against your real configured daemon
unless you mean to change your real bindings.
