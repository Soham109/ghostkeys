# Ghostkeys app: design critique

Reviewed: all 22 PNGs in `app/screenshots/` (captured at 2x from a 1240 x 800 pt window), `docs/design/BRIEF.md`, and the renderer in `app/src/renderer/src`. All sizes below are in points (CSS px at 1x). Hex values come from the BRIEF tokens unless marked "new".

## Verdict in one paragraph

The bones are right: hairline rows, mono labels, no cards on the main screens, a real line drawing of the laptop. It does not yet shock anyone, because the one thing the brief says should carry the product (light appearing only where a touch lands) is almost invisible, while eight candy colors, a column of bright white toggles and a stack of red warnings do the shouting instead. The app currently reads as "a very tidy shadcn app with a laptop diagram". To read as a precision instrument it needs to become quieter everywhere except the touch, and the touch needs to become the event of the screen.

---

## Part 1. Ranked problems across the whole app (most impactful first)

### 1. The zone palette is rainbow candy and it steals the accent's job
- `shared/defaults.ts` `ZONE_COLORS = ['#6E9BFF', '#4FC9B0', '#B58CFF', '#FF7A93', '#8AC96B', '#5FB8E8', '#E58CD6', '#9AA7FF']`. These are eight saturated hues at roughly equal chroma: exactly the "AI dashboard" look the client banned. `#FF7A93` (right grille) and `#E58CD6` (right edge) sit close to `--signal` and dilute it.
- The same hex set is used in light theme, so on `#F4F4F1` they turn into pastel Easter-egg outlines (see `zones-light.png`, `live-light.png`).
- The brief itself (section 5) says zones are "1px strokes in `--ink-3`" with "6 percent fill on hover". The build drifted from its own brief.

**Fix (pick A; B only if product insists on per-zone color):**
- **A. Monochrome zones, identity by number.** Every zone outline is `--ink-3` at 1px, fill 0. Each zone gets a mono index `01` to `08` (11px Geist Mono, +0.08em, `--ink-3`) at its top-left, name only on hover or selection. Lists use the same `01` in place of the colored dot. Selected zone: stroke `--ink` at 1px, fill `--ink` at 6 percent. A touched zone flashes `--signal`. This is the Teenage Engineering move and it makes the orange feel like an LED again.
- **B. Mineral palette (new), low chroma, equal lightness, no hue near orange.** Dark: `#8C97AB` slate, `#8AA39A` sage, `#A39A8A` sand, `#9B90AB` heather, `#9CA08C` lichen, `#8A9FA8` steel, `#A3938F` clay, `#96969C` graphite. Light theme uses a darker set at the same hues: `#5D687C`, `#5A7369`, `#75695A`, `#6B607B`, `#6A6E5B`, `#5A6F78`, `#75625E`, `#66666C`. Render them only as a 1px stroke at 70 percent and a 6px dot in lists. Never as fills above 4 percent.
- Put the palette in `globals.css` as `--zone-1` to `--zone-8` per theme, not as hex in `shared/defaults.ts`, so light and dark each get a correct set.

### 2. The touch, the hero of the product, is nearly invisible
- `live.png`: the only trace of a tap is a dim 6px brown dot in the left palm rest. The ring (`LaptopMap.tsx` ~line 290) is `strokeWidth 1.5`, scale 0.4 to 1.6 of a small circle, 520ms, and it is already gone in every capture.
- There is no connection between the map and the "Recent gestures" list: a tap does not visibly travel anywhere.

**Fix:**
- Ring: start radius 6, end radius 44 (in screen pt, not svg units, so it looks the same at every window size), stroke 1px `--signal`, opacity 1 to 0, 640ms `--ease-out`. Fire a second ring 90ms later at 70 percent opacity for a "ripple in metal" feel.
- Core: a 4px filled `--signal` dot that holds 1.1s (same as the HUD hold) then fades 280ms.
- Zone response: the touched zone's stroke goes to `--signal` for 160ms then eases back to `--ink-3` over 900ms. Fill goes to `--signal` at 10 percent then 0 over 600ms (already exists at 22 percent: too strong a flat wash, and it tints the whole rectangle, which reads as a button highlight rather than a felt touch).
- New row in Recent gestures: enters with y -8 to 0, opacity 0 to 1, 280ms `--ease-snap`; its leading index dot is `--signal` for 1.1s then settles to `--ink-3`. The eye goes map, then list.
- Under `useReducedMotion()`: no ring, just the dot and the zone stroke change.

### 3. `--signal` and `--danger` are the same color to a human eye, and danger is everywhere
- `--signal #FF5B1F` vs `--danger #FF6B5E`. Side by side they are both "hot orange-red". The brief says the accent "appears nowhere else", yet red now appears on: calibration weak-zone bar and percentage, confusion-matrix off-diagonal cells, "Needs approval" badge, shell warning triangle, "Delete zone", "Delete" in the sheet, failed actions in Recent gestures, the offline dot.
- Result: when a real touch lands, the orange has no scarcity left.

**Fix:**
- Danger is not a color in this system. Destructive buttons are `--ink-2` text; on hover they become `--ink`; the confirm step (a second click or a dialog) is the only place a red appears, using a colder red (new) `--danger: #E5484D` dark / `#CD2B31` light, and never next to a touch.
- Weak calibration zone: bar in `--ink-2` with the missing part drawn as a 1px dashed `--hairline-strong` track, percentage in `--ink`, plus a mono tag `WEAK` in `--ink-2`. Not red.
- Confusion matrix mix-ups: `--ink` at opacity proportional to share, not red.
- "Needs approval": plain mono `REQUIRES YOUR APPROVAL` in `--ink-2`, no border, no pill, no icon.
- Shell warning: a sentence in `--ink-2`, no triangle.

### 4. Seven bright white toggles are the loudest thing in the app
- `bindings.png`: the "ON" column is a vertical stack of `#EDEDEF` pills 30 x 18. They outshine the gesture names and the actions, and they sit on the left, which is not where macOS puts switches.
- Row height is 52pt (off the 8pt grid; the brief says 32 for single-line rows).

**Fix:**
- Move the switch to the trailing edge of the row, 26 x 16 (the macOS "mini" switch proportion), track `--hairline-strong` off / `--ink-2` on (not `--ink`), knob `--bg` on / `--ink-2` off. Only the focused or hovered row's switch goes to full `--ink`.
- Rows: 48pt two-line (title 13/18, subtitle 12/16, 7pt top and bottom padding), hairline inset 16 from the left, per brief.
- Column grid: `01` index 32pt, WHEN 1fr, DO 1fr, switch 48pt. Put the keystroke on the DO side as keycaps (`⇧⌘T`, 11px mono, `--ink-2`) aligned right before the switch, so the right half is not a dead void.
- The "7 of 8 on" subtitle: mono 11px `--ink-3`, `07 / 08 ON`.

### 5. Generic line icons in the sidebar and buttons
- `Sidebar.tsx` imports `Activity, Command, Crosshair, Settings2, SquareDashed, Waves` from `lucide-react`. BRIEF banned item 5 is precisely "Lucide/Heroicons as decoration". The Live icon is a heartbeat line, Gestures is the ⌘ key, Calibration is a crosshair: this is the stock set every template ships with. Also used on Pause, Library, New binding, Delete (trash), Test (play), Add step.

**Fix:**
- Sidebar: drop icons. Use a mono index in `--ink-3` (`01 Live`, `02 Zones` ... `06 Settings`), 11px Geist Mono, 24pt column, label 13px. The index turns `--ink` when active. This also teaches ⌘1 to ⌘6 for free (currently only visible on hover).
- Buttons: text only. Keep glyphs only where they are real Mac symbols typed as text (`⌘`, `⇧`, `⌥`, `⌃`, `↩`).
- If one icon must survive (for example Pause in the sidebar footer), draw it custom at 1.25px stroke on a 16pt grid to match the logo's rounded joins.

### 6. The laptop drawing is correct in proportion but flat in craft
Measured against a real 14-inch MacBook Pro (312.6 x 221.2 mm, `geometry.ts` uses 3 svg units per mm):
- Base ratio in `live.png` is 933 x 660 display px, about 1.41. Real is 1.413. Good.
- Trackpad width about 0.42 of the case. Real is about 0.44 (about 138 mm). Close. But its bottom edge sits about 15 mm above the front; on the real machine it is about 8 mm. Move it down 7 mm; this also enlarges the palm rests, which are the most used zones.
- Speaker grilles: real grilles run the full keyboard height and are about 11 mm wide beside the keys, with perforations on a hex offset, not a square grid. Current pattern (`grille-dots`, 4.2 unit square, r 0.85 at 75 percent) reads as a checkerboard texture at small sizes. Use an offset hex pattern, r 0.6, opacity 0.45, pitch 3.6.
- Missing Touch ID key (top-right key of the function row is a different shape on real Pros: a square key with a ring). Add a 1px inner circle. It is the one detail a Mac person notices.
- Function row keys on the real machine are full height on M-series Pros (not half height). The current 0.6 row reads like an older model. Use 1.0 height, or 0.9 at most.
- The keyboard well: real Pros have a recessed black well around the keys. Draw one 1px rounded rect around all keys, radius 6, at `--hairline-strong`, and then drop the key strokes to `--hairline`. Today the 78 key outlines at `--ink-3` 45 percent are the most detailed thing on screen and compete with the zones.
- The lid: the "foreshortened" lid is a flat rectangle with a radial glow and a camera tab. It reads as a second tablet above the laptop. Either (a) drop the lid body and show only its front edge as a thin 1px rounded bar with a notch and the label LID, drawing the lid zone on that bar; or (b) apply a subtle perspective: top edge 94 percent the width of the bottom edge, 1px, with the display drawn as an inset 1px rect with no gradient.
- The hinge: current dotted line at 2/5 dash reads as "perforation, tear here". Use a solid 1px `--hairline-strong` line with 12pt gaps at each end for the hinge barrels.
- Edges and front lip drawn as capsules outside the body: the "exploded view" idea is great, but capsules filled `--fill` look like scrollbars. Draw them as 1px open brackets (just the outer contour, no fill) with 4pt spacing from the body, and put the labels in mono at 10px on the outside.
- Stroke weights: everything is 1px. Instrument drawings use two weights. Outer contour 1.25px `--ink-3`, internal detail 0.75px `--hairline-strong`. `vector-effect: non-scaling-stroke` is already in place, so this is a CSS change in `globals.css` (`.stroke-strong` 1.25, `.stroke-faint` 0.75).
- Zone labels: rotated 90 degree text in the grilles ("Left grille" vertical) is the cheapest-looking element on the map. Never rotate zone labels. Put the label outside the body with a 1px leader line to the zone (callout style, mono 10px, `--ink-3`), or show it only on hover and selection.

### 7. Light theme is a recolor, not a design
- `--ink-3 #9A9A9E` on `#F4F4F1` is 2.54:1. Every mono label (SERVICE, SENSORS, RECENT GESTURES, LID, FRONT LIP) fails. See `live-light.png`: the labels are ghosts.
- Zones become pastels (see item 1). The lid rect with `bg-sunken #EFEFEB` is barely different from `--bg`.
- The accent `#E5480C` on `#F4F4F1` is 3.62:1: fine for a ring, weak for the chart labels in `sensors-light.png`.
- The sidebar `#E9E9E5` vs content `#F4F4F1` works; keep it.

**Fix:** light `--ink-3` to `#707076` (4.46:1), light `--hairline` stays `#DADAD5`, add light `--hairline-strong #C4C4BE`. Laptop outer contour in light should be `--ink-2 #65656B` at 1.25px, because light-on-light line drawings need more weight than dark ones. Signal labels in light use `--ink` text with a 6px `--signal` dot, not orange text.

### 8. Label contrast in dark theme fails too
- `--ink-3 #55555B` on `#0A0A0B` is 2.67:1, and on the sidebar `#121214` 2.53:1. That is every section label, every timestamp, the "⌘K", the helper sentences at the bottom of Live and Zones.
- **Fix:** dark `--ink-3` to `#76767D` (4.39:1 on `--bg`, 4.15:1 on sidebar). For purely decorative strokes (the drawing), keep a separate `--line: #3A3A40` so the drawing does not brighten when labels do.

### 9. Status row on Live is a web dashboard, not an instrument
- `live.png`: five equal columns (SERVICE / SENSORS / CALIBRATION / ACCESSIBILITY / MOTION SENSOR), each label over a 13px value. "797  Hz" has a double space look because of mono tracking. "Grant" is a bordered chip inside a sentence.
- Four of the five are "all fine". Fine things should not take a full row.

**Fix:** collapse to one mono line under the title, 11px `--ink-3`: `CONNECTED · 4/4 SENSORS · TRAINED · 797 HZ`. Anything that is not fine breaks out of the line as a full sentence in `--ink` with an inline text link: "Ghostkeys can't press keys yet. Allow in System Settings." That gives the laptop 64pt more height and turns problems into the only thing you read.

### 10. Recent gestures list is noisy
- Every row is two lines, 44pt, with the same "now" repeated 7 times, and duplicates ("Top strip / Triple tap / Screenshot of an area" three times).
- **Fix:** single line rows, 32pt: `01` index, "Double tap", then action in `--ink-2`, time right in mono. Collapse repeats within 3s into one row with `×3` in mono. Group by minute with a mono divider (`14:32`). Relative time as `0s`, `5s`, `1m`, not "now".

### 11. Spacing is close to the grid but not on it
Measured from 2x captures:
- Page header 52pt, good. But the gap from header to first content varies: Live 8pt (facts row), Zones 24pt, Bindings 12pt, Settings 16pt. Make it 24pt everywhere.
- Content padding: brief says 24; Live map pane uses `px-10 pt-8` (40 / 32). Pick 32 for map panes and 24 for list panes and write them down.
- Right inspector is 300pt (Live) and about 300 on Zones. Put it on the grid: 304 or 320.
- Sidebar: brand block sits at 62pt from the top with 20pt below. The traffic lights end at about 30pt; the brand should sit on the same baseline row as the traffic lights (y 18, left 88) or be removed; the sidebar already says "ghostkeys" in the dock and menu bar. Removing it gives the nav a clean start at 52pt, like Finder and Notes.
- Onboarding bottom bar: "Skip introduction" is 16pt from the right edge, "Get started" is 52pt from the right edge, "01 / 04" is 52pt from the left. Align all three to the same 48pt gutter.
- Calibration results: "Recalibrate weak zones" and "Done" are vertically centered against a two-line paragraph, not aligned to its first baseline or to the "93%" baseline. Align the button row's baseline to the 93% baseline.

### 12. Type: good choices, loose execution
- Headline weights look semibold in onboarding ("Your MacBook has hidden keys."). The brief allows 400 and 500 only. Use 500 at 44px, tracking -0.035em, line-height 0.92 (current line-height looks about 1.05). Serif italic "hidden" is good, keep it, but set it 2px larger (Instrument Serif runs small) and give it the 120ms delayed blur-in from the website brief.
- Calibration heading ("Teach Ghostkeys how your taps feel.") at 20 with body 15/1.6: fine, but the body line length is about 58ch in a 560pt column. Cap at 52ch.
- Big numerals (93%, 27, 13 of 20, 113°, 48%) mix Geist Mono and Geist. Pick one: all big numerals in Geist 500 with `tabular-nums`, tracking -0.035em; unit (%, °, "seconds") in 13px mono `--ink-3`, baseline aligned, 4pt gap. Today "113°" has a floating tiny degree and "48 %" a gap.
- Mono section labels at 11/16 +0.08em: correct. But "EVERYWHERE", "MICROSOFT EXCEL" group headers and column headers "ON / WHEN / DO" use the same style, so hierarchy is flat. Make group headers 11px mono `--ink-2`, column headers 10px mono `--ink-3`.
- Settings slider values mix "Balanced" (word) and "450 ms". Show both: `450 MS` mono, and the word only on the sensitivity row, in 13px sans. Right-align values to a 64pt column.

### 13. Popovers and overlays look like shadcn defaults
- Library dialog and command palette: 12pt radius, `--pop-shadow` (a drop shadow, banned item 8), a 50 percent black scrim. The library list is clipped at the bottom with a half-visible line ("From the shared preset library. Pick...") and the palette's last item touches the edge with no bottom padding.
- **Fix:** use real macOS material for floating panels (`vibrancy: 'popover'` if it is a child window, or `backdrop-filter: blur(40px) saturate(1.4)` over `color-mix(in srgb, var(--bg-raised) 72%, transparent)`), a 1px `--hairline-strong` inner border, radius 10, no drop shadow, scrim at 24 percent. Always 8pt bottom padding plus a fade mask (`mask-image: linear-gradient(to bottom, black calc(100% - 24px), transparent)`) where a list scrolls.

### 14. Microcopy is plain (good) but leaks internals in two places
- Service offline screen: "Build it from the daemon folder with `swift build -c release`" and two relative file paths. That is a developer message in a shipped UI.
- "Minimum confidence: Taps the model is less sure about than this are ignored." "The model" is jargon.
- "Show the HUD": "HUD" is jargon for most people.
- IGNORED panel shows "17 total" and "Nothing ignored yet." at the same time (`sensors.png`). Contradiction.
- Details below per screen.

### 15. Motion is correct but timid, and misses the moments that matter
Current: nav highlight slides (240ms snap), sheets slide 24pt, dialog 6pt rise, zone fill fade. Missing:
- Screen change: content should crossfade 160ms with y 4 to 0; right now route changes are a hard cut.
- Zone selection (Zones and Live): brief says bindings slide in x 12 to 0, 280ms. Implemented as a panel swap without that slide on Live.
- Calibration counter: each tap should advance the ring with a spring (`type: 'spring', stiffness: 520, damping: 38`, no overshoot visible) and the number should roll (old digit y 0 to -8 and out, new digit 8 to 0, 160ms).
- Results: 93% counts up from 0 over 900ms `--ease-out`; per-zone bars grow with 30ms stagger.
- HUD: text width change uses `layout`, good. Add the 6px dot doing one pulse (scale 1 to 1.6, opacity 1 to 0 ring) on enter.

---

## Part 2. Per screen

### Live (`live.png`, `live-light.png`, `command-palette.png`)
1. **Touch invisible.** See item 2. This is the whole product; fix first.
2. **Zone colors.** See item 1.
3. **Facts row.** Collapse to one line (item 9). "Not granted [Grant]": replace with a sentence banner only when not granted.
4. **Map pane has no pulse when nothing happens.** Add the wow moment: a live **seismograph line** under the laptop, full map width, 40pt tall, 1px `--ink-3`, drawing the magnitude of acceleration (sqrt of x²+y²+z² minus 1 g) scrolling right to left over the last 4 seconds at 60fps. When a tap is detected, the spike segment is redrawn in `--signal` and a small mono label with the zone index (`03`) sits above it for 1.1s. Rejected bumps (typing) stay grey and get a tiny tick below the line. It shows the product "listening" when idle and explains why typing does not trigger taps, without a word of copy. Data is already streamed for the Sensors screen.
5. **Footer hint** "Tap a zone on your MacBook to see it light up. Click a zone here to see what it does." Two instructions in one grey line at the bottom of the pane. Show it only when there have been no taps this session, centered under the laptop, 13px `--ink-2`: "Tap anywhere on your MacBook." Then it disappears forever after the first tap (with a 280ms fade).
6. **Pause button** top right duplicates the sidebar pause. Keep one: the sidebar footer, which is always visible.
7. **Recent gestures.** Item 10.
8. **Empty state for the list** (fresh install): currently unknown in the screenshots. Should be: mono `RECENT GESTURES` then a single 13px `--ink-3` line "Nothing yet." No illustration.
9. **Command palette**: good bones. Remove the `⌘1` hints' 11px mono at `--ink-3` (invisible, 2.5:1); raise to `--ink-2`. Add 8pt bottom padding. Make group labels `GO TO` / `ACTIONS` 10px. Highlight row: `--fill-active` with 6pt radius is fine.

### Zones (`zones.png`, `zones-light.png`)
1. **Selection handles** are four white squares with black strokes at the corners, 8pt: the Figma default. Use 6pt circles, fill `--bg`, stroke `--ink` 1px, and show them only on the selected zone while hovering it. Add a 1px dashed `--ink-3` bounding line 3pt outside the zone during drag.
2. **Snapping feedback** is invisible. When a zone edge snaps to another zone or to the keyboard, draw a 1px `--ink-2` guide line across the case for as long as the snap holds (like Figma's red guides, but in ink).
3. **Right panel** mixes three widget types (list, text field, native select, color dots, number readouts, red delete). Order and style:
   - List rows 32pt single line, `01` index, name, surface right in `--ink-3`.
   - NAME: inline editable title (15px, 500) instead of a boxed input. The field border appears on hover and focus only.
   - SURFACE: fine as a native-looking select but make it borderless with a chevron, 28pt.
   - COLOR: if palette A (monochrome) is adopted, this control disappears entirely. If palette B, show 8 swatches 16pt with 8pt gaps, selected shows a 1px `--ink` ring 2pt outside.
   - POSITION: "X 0.74 Y 0.56 W 0.23 H 0.35" are unitless fractions. Show millimetres from the physical corner: `X 231 mm  Y 124 mm  W 72 mm  H 77 mm`. Real units make it feel like an instrument; fractions feel like a debug panel. Make them scrubbable (drag horizontally on the label to change), a very Mac pro-app touch.
   - "Delete zone": `--ink-2` text, bottom of the panel, 24pt above the bottom edge; confirm on second click ("Click again to delete", 2s).
4. **"8 zones"** subtitle: mono `08 ZONES`.
5. **Reset icon** (circular arrow) next to "Add zone" has no label. Make it a text button "Reset" or move it into a `…` menu.
6. **Helper copy** at bottom is two lines and wraps mid-sentence. Rewrite: "Drag to move. Drag a corner to resize. Arrow keys nudge; ⌥ + arrows resize." Zones-overlap rule is enforced by the UI, so it needs no sentence.
7. **"Add zone" flow**: new zone should appear with a 280ms scale 0.96 to 1 plus stroke draw-on (`pathLength` 0 to 1, 400ms) at the largest free area, already selected, name field focused.

### Gestures and actions (`bindings.png`)
1. Toggles, row height, column layout: item 4.
2. The colored dots before gesture names duplicate the zone name printed under them. With monochrome zones, replace with the `01` zone index.
3. The "Sequence" double dot (two overlapping 6pt dots) looks like a rendering glitch. Show `02 → 01` in mono.
4. Shift keycap chip after "Triple tap" floats between columns. Put modifiers inline in the WHEN subtitle as text glyphs: "Top strip · ⇧".
5. Disabled row (Lid nudge) at 50 percent opacity makes its text unreadable (1.9:1). Use `--ink-2` for the title and `--ink-3` (new value) for the rest; do not multiply opacity.
6. **Filter field** in the header is 200pt wide with a magnifier icon: fine, but make it expand on focus from 160 to 240 (200ms snap).
7. **Empty state** (no bindings): "No gestures yet." 13px `--ink`, then "Start with a ready-made layout" as a text link opening Library at the Ready-made layouts tab. No box.
8. Primary "New binding" is a white filled button next to an outlined "Library" button: two emphasized buttons in a 52pt header. Make "Library" a plain text button.

### Binding editor sheet (`bindings-editor.png`)
1. **Label style inconsistency**: "WHEN" and "DO" are mono section labels; "Gesture", "Zone", "Holding", "In" are sentence-case left labels; "Name" and "Modifiers" are sentence-case labels above fields. Pick one: left labels 13px `--ink-2` in a 96pt column for every field, section labels mono.
2. **Modifier keycaps**: two rows of the same `⌃ ⌥ ⇧ ⌘ fn` controls ("Holding" and "Modifiers") in one sheet is confusing. Rename "Holding" to "While holding" and "Modifiers" goes away, since the recorded shortcut already shows ⇧⌘T. If a modifier toggle row stays, selected keys use `--fill-active` background and `--ink` glyph, not solid white (currently the brightest element in the sheet).
3. **"Click to record"** right-aligned in a 64pt tall box: make the whole field the target, placeholder left-aligned "Press a shortcut", and while recording show a 1px `--ink` border with a slow breathing opacity (1 to 0.5, 1.4s) instead of any red.
4. **Bundle id `com.microsoft.Excel`** in mono inside the app picker: developer detail. Show the app icon (16pt, real macOS icon via `app.getFileIcon`) and name. Bundle id only in a tooltip.
5. **Sheet chrome**: the sheet has a dim overlay on the table behind (content goes to about 40 percent). Use 24 percent, and let the sheet background be `--bg-raised` with a 1px `--hairline` left edge. No shadow.
6. **Footer**: "Delete" red with trash icon, then "Test" outlined with play icon, then "Done" white. Make Delete `--ink-2` text, Test a text button, Done primary. Footer height 56, buttons 28, 24pt side padding (currently about 20).

### Macro builder (`bindings-macro.png`)
1. **Step rows** are good in concept (mono `02`, `03`, drag handles). But each step has a select, a "wait 120 ms" box, a play and an x: four controls of different heights (28, 28, 16, 16). Align all to 28pt and hide play and x until row hover.
2. **Window arrangement grid** uses a raised rounded tile for the selected choice: a card. Make it a 3 x 3 grid of small 1px outline diagrams (24 x 16) with the label below in 12px; selected diagram fills its active half with `--ink` and the label goes `--ink`. No background tile.
3. **"Needs approval" red pill + warning triangle + red shield on step 04**: three red alarms for one fact. See item 3. One line under the command field in `--ink-2`: "macOS will ask you to approve this exact command before it runs."
4. **Counter** "4/50 steps, 0.45/30 s" in mono is good, keep it, but tighten to `04/50 STEPS · 0.45/30 S`.
5. The sheet scrolls under the header with the previous step's controls peeking at the top (cut in half). Add a 16pt fade mask under the sheet header.

### Library (`bindings-presets.png`)
1. Floating panel with drop shadow and 12pt radius: item 13. Better: open the library as a full-height sheet from the right, the same as the editor. One pattern for "side work", not two.
2. **Two tag columns** ("Music" and "Media") on every row. Drop the category tag (you already filtered by it, or you are in "All" where it is redundant with section headers). Group "All" by category with mono section headers instead.
3. **"Use"** appears on hover only in the highlighted row: fine, but make it a text button 12px `--ink`, right, 16pt from the edge, and also bind ↩.
4. Descriptions truncate with ellipsis ("Controls Spotify directly via AppleScript instead of the system ..."). Rewrite to fit one line or allow two lines. "via AppleScript" is jargon; write "Talks to Spotify directly."
5. Category counts right-aligned mono: good. Selected category background `--fill-active` radius 6: good.
6. Left column footer text is clipped. Bug.

### Calibration: choose zones (`calibration-1-pick.png`)
1. **Checkboxes** are solid white squares with black checks: brightest element again. Use 14pt, 1px `--ink-3` border unchecked; checked: `--ink` border, `--ink` check glyph, no fill.
2. **Map on the right** is fine. Unchecked zones should be dashed 1px, not merely dimmed, so "not included" reads at a glance.
3. **"Taps per zone 10 / 20 / 30"**: good control. Add the consequence in mono under it: `ABOUT 3 MIN`. (A duration derived from tap count, shown as a fact, not a promise.)
4. **Primary button "Start with left palm rest"**: good specific copy. Make it 32pt tall (the `lg` size) since it is the only action on the screen.
5. Heading line-height: 20/1.2. Body: `--ink-2`, 15/1.55, max 48ch.

### Calibration: tap each zone (`calibration-2-capture.png`)
1. **The counter ring** (thin white arc, big "13", mono "of 20") is the best element in the app. Keep it. Upgrade: each tap adds a tick mark on the ring's circumference (20 ticks at 1px, `--ink-3`, the completed ones `--ink`), and the tick that just filled flashes `--signal` for 160ms. A physical, countable instrument dial.
2. **Wow moment: calibration heatmap.** Every tap in this step leaves a persistent 3pt dot at its reported point inside the focused zone, `--signal` at 100 percent for 600ms then settling to `--ink` at 35 percent. After 20 taps the user sees their own tap cloud: where they actually hit. On the results screen, the same dots come back for every zone, colored `--ink` for correctly recognised taps and hollow for misread ones. This makes "right grille is confused with top strip" visible: the hollow dots will cluster near the top strip.
3. **Focused zone** pulses its outline stroke opacity between 0.5 and 0.1 on a 1.8s loop. A double outline (inner zone stroke plus outer white stroke) reads like a selection bug. Use a single 1px `--ink` stroke, steady, and let the tap marks provide the motion.
4. **Zone list** with mini progress lines: lines are 1px and the incomplete ones vanish. Use 2px track `--hairline`, fill `--ink`, fraction in mono. Done zones get a mono `DONE` instead of 20/20 (less number noise).
5. **Cancel / Skip this zone** at the very bottom-left, far from where the eye is. Put them under the zone list, 24pt below.
6. Copy "Use one fingertip. Vary the spot and strength a little, the way you would in real use." Good. Keep.

### Calibration: type normally (`calibration-3-negatives.png`)
1. **Layout** changes completely from step 2 (ring moves left, text to the right, laptop gone, bottom 60 percent empty). Keep the same two-column frame as step 2 for all four steps: instructions and counter on the left, a visual on the right. The visual here is the **seismograph line** from Live, large, with every keystroke drawing a grey tick and the label `TYPING` in mono. That shows "we are learning what to ignore".
2. **Textarea** is a boxed field with a resize grip and "The quick brown fox" placeholder. Make it borderless, 20px text, `--ink`, with a blinking caret, like writing on the page. Hide the resize grip.
3. **"TYPING HEARD 38 / TRACKPAD HEARD 11"**: good facts. Put them under the counter in the left column.
4. **"Cancel calibration"** is bold-ish text at 13px with no affordance. Same position and style as step 2's cancel.
5. Heading "Now just type, and use your trackpad." Good. Body is 3 lines of 15px; cut to: "Type anything and use the trackpad as usual. Don't tap the zones."

### Calibration: results (`calibration-4-results.png`)
1. **93%**: correct move (a big numeral carries the spec). Push it: 120px Geist 500, tracking -0.035em, line-height 0.92, `%` in 28px `--ink-3`. Count up on enter.
2. **Weak zone in red**: item 3.
3. **Confusion matrix** ("What each tap was taken for"): rounded 32pt squares with 4pt gaps look like a card grid. Column labels rotated 45 degrees look like a 2010 Excel chart. Fix:
   - No cell radius, no gaps; 1px `--hairline` grid.
   - Row and column headers use the zone indices `01` to `08` plus `IG` for ignored, in mono, horizontal. The row header also shows the name; columns only the index.
   - Cell text shown only when greater than 0; opacity of the number and a background of `--ink` at `share * 0.18` for every cell (diagonal included). The diagonal then reads as a clean bright stripe and mix-ups as faint grey smudges. No red.
   - Explanation line under it is good. Shorten: "Rows: where you tapped. Columns: what Ghostkeys heard."
4. **Advice** has a red bullet dot. Remove the dot, write it as a numbered row `01` in mono and a 15px sentence, per the brief's numbered-rows rule.
5. **Summary sentence** "One zone needs attention. The rest are reliable and ready to use." wraps with "use." alone on line two. Rewrite: "Seven zones are ready. Right grille needs another pass."
6. Buttons "Recalibrate weak zones" (outlined) and "Done" (white) are side by side at equal weight next to the summary. Primary should be "Recalibrate right grille" (specific); "Done" a text button.

### Sensors (`sensors.png`, `sensors-light.png`)
1. **Series colors** X blue `#7AA2FF`, Y teal `#5CC8B0`, Z grey: default chart palette. Make it monochrome: X `--ink` 1px, Y `--ink-2` 1px, Z `--ink-3` 1px dashed 2/2. Legend as mono `X  Y  Z` using the same line styles.
2. **Tap markers**: vertical `--signal` lines across both charts are correct use of the accent (they are touches). But labels collide ("TOP STRIPRIGHT PALM REST", "LOW LIDONFIDENCE"). Use zone indices (`01`) instead of names, 10px mono, and stagger labels onto two rows when they are closer than 40pt. Rejected events: dashed `--ink-3` line with no label unless hovered.
3. **Left 45 percent of both charts is empty** because the buffer is still filling. Draw the baseline (flat line at 0 and -1 g) across the empty region, or start the plot from the right edge and let it grow leftward. A chart with half its area blank looks broken.
4. **Y axis labels** "0.50 / 0 / -0.50 / -1 / -1.5 / -2": inconsistent decimals. Use `0.5 / 0 / -0.5 / -1.0 / -1.5 / -2.0` or integers only.
5. **Header subtitle** "59 samples per second shown, 797 Hz read": jargon. `797 HZ · SHOWING 60 FPS` in mono, or cut.
6. **Live / Freeze** segmented control: good. Add `space` as the shortcut and show it.
7. **Bottom three panels** (lid angle, ambient light, ignored): content is bottom-aligned, leaving about 150pt of blank above each. Top-align the numerals under their labels at 16pt, then the visual.
8. **Lid angle**: the drawn hinge is a nice idea. Make the line 1.25px `--ink`, and animate angle changes with a spring (stiffness 300, damping 30). "113°": degree sign should be 28px, not superscript-small.
9. **Ambient light** bars: 20 bars with a height ramp (a volume-meter cliché). Use a single 1px horizontal scale with a 6pt tick marking the current level, mono `48%` above it. Quieter and more instrument-like.
10. **IGNORED**: "17 total" together with "Nothing ignored yet." is a bug in the copy logic. Replace the footer line with "Last: typing, 45.8 s ago" (light theme already does this) or nothing.

### Settings (`settings.png`)
1. Structure is right: mono section labels, hairline rows, controls on the right. Keep it.
2. **Content width** stops at about 680pt and leaves a 320pt dead band on the right. Either center a 640pt column or run full width with controls at the right edge. Centered 640 is more Mac (System Settings uses a centered column).
3. **Row heights** vary (48, 64, 80) because descriptions wrap at different widths. Constrain description to one line (max 56ch) and rewrite the long ones, so rows are 56pt consistently (title 13/18, description 12/16, 11pt padding).
4. **Sliders**: 2px track, 14pt white knob with a 3pt `--bg` ring (a shadow trick that looks like a halo). Use the macOS slider look: 4pt track `--hairline-strong`, range `--ink-2`, knob 16pt `--ink` with a 1px `--hairline-strong` border, no halo. Add 5 tick marks under the Sensitivity slider (it is a discrete choice: Light, Balanced, Firm ...).
5. **Copy:**
   - "Minimum confidence: Taps the model is less sure about than this are ignored." to "Certainty needed: ignore taps Ghostkeys isn't at least this sure about."
   - "Show the HUD: A small pill near the top of the screen names each gesture and what it did." to "Show what ran: a small label at the top of the screen after each gesture."
   - "Haptic tick: A light trackpad click confirms each gesture." Good.
   - "Typing pause" good.
6. **Theme** segmented control: good, per brief.
7. **Missing**: a "Sound" row would be on brand (the website brief has UI audio); a felt "thump" on a recognised tap, off by default.

### Onboarding (`onboarding-1-welcome.png` to `onboarding-4-calibrate.png`)
1. **Strongest screen in the set.** Headline with the serif italic, exploded laptop, mono pager `01 / 04`. It is closest to the brief.
2. **The logo mark** sits alone above each headline at 40pt with a hard white stroke and an orange dot. It repeats on every step, same place, doing nothing. Show it only on step 1, 32pt, and animate the dot: it lands (scale 0 to 1, 280ms), flashes `--signal`, and at the same moment the right grille on the drawing lights. That links "the dot where a finger lands" to the product in one beat.
3. **Step 1 laptop**: all zones are drawn at 20 percent and one grille is lit with a brown-orange fill and a white double outline, and its rotated label is overlapped by the tap dot. Instead: loop a tap tour. Every 1.4s a `--signal` ring lands on a different zone (right grille, left palm, top strip, left edge), the zone's outline brightens for 900ms, and a mono caption under the drawing reads the zone index and a sample action (`03  RIGHT GRILLE  →  VOLUME UP`). That is the "shocked" moment: the laptop comes alive before you touch anything.
4. **Step 2 "Checking this Mac"**: white filled check circles in a list. Use mono `OK` in `--ink-2` at the right edge instead, and have each row appear with a 80ms stagger as the check actually completes. Right column text ("Feels taps", "Tilts", "Lid nudges", "Covering it") is good plain copy.
5. **Step 3 accessibility**: the map is at 20 percent with no labels: fine as a quiet backdrop. "Open the prompt" is a bordered button inside a hairline row: make it the primary button. The footer then shows "Continue without it" as a text button, not the white primary (right now the primary action of the screen is to skip the permission).
6. **Step 4**: good copy. "Start calibration" 32pt primary; "Skip for now" text. Footer "Back" alone on the right looks orphaned; put Back on the left of the footer on every step, primary on the right.
7. **Transitions between steps**: none visible in code beyond fades. Headline should re-enter with a line mask reveal (y 110 percent to 0, 900ms `--ease-out`, 80ms per line), the laptop stays put and only the zone emphasis changes. The drawing must never re-mount between steps.
8. **Gutter mismatch** in the footer: item 11.

### Service offline (`service-offline.png`)
1. Developer copy with build commands and file paths. Split the states:
   - Shipped app, helper not running: "Ghostkeys isn't listening." Body: "Its background helper stopped. Restart it to bring your gestures back." Primary: "Restart helper". Secondary text link: "Show details" which reveals the paths in mono.
   - Dev build only (`!app.isPackaged`): the current text is fine, but under a mono `DEVELOPER` label.
2. The logo mark here is grey with a grey dot: good idea (the dot is "not lit"). Make that explicit: dot at `--ink-3`, and the drawing of the laptop at 12 percent behind the text, fully unlit. It is the only empty state that can say "silence" with the product's own image.
3. Sidebar still shows full nav while every screen is dead. Dim nav items to `--ink-3` and disable them.
4. Headline at 28 is fine; body line length is about 70ch; cap at 56ch.

### HUD (`hud.png`)
1. Close to the brief. Pill height about 35, dot 6pt `--signal`.
2. Replace the vertical bar separator with the brief's `·`, and render "Volume down" in `--ink-2`. Current bar reads as a text cursor.
3. The pill border plus faint shadow: use only the `hud` vibrancy and a 0.5px `rgb(255 255 255 / 0.12)` inner border (hairline on Retina). No shadow.
4. Add the dot pulse on enter (item 15) and, for failed actions, show the dot hollow (`--ink-3` ring) with the action text struck in `--ink-3`, never red.

---

## Part 3. Native Mac feel

1. **Screenshots use solid backgrounds** (`SCREENSHOT` mode disables vibrancy), so I cannot judge the real vibrancy. In code: `vibrancy: 'under-window'` for the whole window with the sidebar at 55 percent tint. Recommend `vibrancy: 'sidebar'` for the sidebar region specifically (Electron applies one material per window, so keep `under-window` and set the content pane to an opaque `--bg`, leaving only the sidebar translucent; that is what Finder and Notes do). Verify the sidebar tint in light mode is not muddy: 60 percent of `#ECECE8` over a colorful wallpaper will pick up color; drop to 40 percent.
2. **Traffic lights** at `{16, 18}` is right for a 52pt header. The sidebar's brand block below them wastes the top row; see item 11.
3. **Title bar**: the page title sits in the 52pt drag region, good. Add a 1px `--hairline` under the header only when content scrolls under it (scroll-linked, 160ms fade), like Mail and Notes. Right now some screens have a permanent line and others none.
4. **Selection color**: the sidebar active row uses `--fill-active` grey. Native Mac sidebars use the accent color when the window is key. Grey is right for this brand (the accent is reserved), but dim it further to `--fill-hover` when the window is not focused (`document.hasFocus()` / `blur` event). That single detail sells "native".
5. **Cursor**: `cursor: default` everywhere is correct Mac behaviour. Keep it; do not add pointer cursors to buttons.
6. **Menus**: `…` menus and the app picker should use native context menus (`Menu.popup`) instead of custom popovers. Instantly native.
7. **Keyboard**: ⌘1 to ⌘6 exist; add ⌘N (new binding), ⌘F (filter), ⌘, (settings), space (freeze sensors), Esc to close sheets. Show them in the native menu bar, which is where Mac users look.

## Part 4. Accessibility

1. Contrast: raise `--ink-3` in both themes (items 7 and 8). New values: dark `#76767D`, light `#707076`.
2. Focus ring: `outline 2px solid color-mix(ink 55%)` offset 2. Good width, but it is square on rounded controls and grey. Use `outline-offset: 2px; border-radius: inherit` and 2px `--ink` at 70 percent. Never `--signal` (it means touch).
3. Zone identity currently relies on hue only. Monochrome palette with indices (item 1) fixes color-blind use at the same time.
4. Disabled rows at 50 percent opacity fail contrast (item bindings 5).
5. The map zones are `role`-less `<g>` with focus handling; add `role="button"` and `aria-label="Left palm rest, 2 gestures"`.
6. Every animation already checks `useReducedMotion()` in the map; make sure the new seismograph line freezes to a static last-4-seconds snapshot under reduced motion.
7. Tap announcements: add an `aria-live="polite"` region that reads "Left grille, volume down" so VoiceOver users get the HUD's content.

## Part 5. Wow moments to add (in order of payoff)

1. **Seismograph line** under the laptop on Live and in calibration step 3 (described under Live 4). Shows the product listening, and shows why typing is ignored.
2. **Touch ripple done properly** (item 2): two rings, a held dot, zone stroke flash, list row slide. It is the product's signature; it deserves 30 lines of code.
3. **Calibration tap cloud / heatmap** (calibration step 2 and results).
4. **Onboarding tap tour**: the laptop taps itself on step 1.
5. **Drawing draws itself** on first launch: the laptop contour animates `pathLength` 0 to 1 over 1400ms `--ease-inout`, then keys fade in with a 4ms stagger, then zones. Only on first launch and on the service-restored moment; never on route changes.
6. **Idle breathing**: when nothing has happened for 30s on Live, the hairline under the header and the seismograph line very slowly breathe (opacity 0.6 to 1, 4s). Stops the instant a tap lands.
7. **Optional felt sound** on recognised tap (Settings, off by default).

---

## Top 10 changes that would most raise perceived quality

1. **Make the touch the event.** Two `--signal` rings (radius 6 to 44pt, 640ms expo-out, second ring +90ms), a 4pt dot held 1.1s, zone stroke flashes signal for 160ms, new list row slides in. Today a tap is a barely visible dim dot.
2. **Kill the rainbow.** Replace `ZONE_COLORS` with monochrome zones (1px `--ink-3`, 6 percent fill on hover/selection, mono indices `01` to `08`), or at most the low-chroma mineral palette with separate light and dark sets. This alone moves the app from "dashboard" to "instrument".
3. **Stop using red.** `--danger #FF6B5E` is indistinguishable from `--signal #FF5B1F`. Remove red from weak zones, confusion matrix, approval badge, warning icons, delete buttons and failed actions; use ink weights and plain words. Red only on a destructive confirm, in a colder `#E5484D`.
4. **Add the seismograph line** under the laptop (Live and calibration step 3): 1px `--ink-3` live acceleration trace, tap spikes redrawn in `--signal` with the zone index, typing ticks in grey.
5. **Fix contrast tokens.** `--ink-3` dark `#55555B` (2.67:1) to `#76767D`; light `#9A9A9E` (2.54:1) to `#707076`. Every mono label in the app currently fails.
6. **Craft pass on the laptop drawing**: two stroke weights (1.25 contour, 0.75 detail), keys dropped to `--hairline` inside a drawn keyboard well, full-height function row with Touch ID, hex grille perforation, trackpad moved 7mm lower, lid reduced to a thin edge or given real perspective, rails as open brackets, and no rotated labels.
7. **Remove Lucide icons** from the sidebar and buttons. Sidebar becomes mono indices `01 Live` to `06 Settings`; buttons are text. Remove the redundant brand block under the traffic lights.
8. **Quiet the controls.** Switches trailing, 26 x 16, on-track `--ink-2` not white; checkboxes outline-only; selected modifier keys `--fill-active` not solid white; one primary button per screen. Right now the brightest pixels on most screens are form controls.
9. **Collapse Live's facts row** into one mono status line (`CONNECTED · 4/4 SENSORS · TRAINED · 797 HZ`), with only real problems breaking out as a sentence. Make Recent gestures single-line 32pt rows with repeats collapsed.
10. **Rebuild the calibration results and capture as instruments**: tick-mark dial that flashes signal per tap, persistent tap cloud in the zone, 120px count-up 93%, confusion matrix as a flat hairline grid with indices and ink-opacity cells (no rounded squares, no rotated labels, no red), and one layout frame shared by all four calibration steps.
