# GhostkeysVision (optional camera add-on)

Off by default. When the user turns it on, the camera runs only during short "air sessions" (default hard stop at 30 s),
never in the background.

What it does:

- **In-air gestures** in front of the screen, seen by the front camera (the main mode).
- **Desk surface mode** (experimental): Desk View fingertips mapped onto the laptop deck, touch vs hover, and a
  circle-to-turn knob.

The built-in camera almost certainly cannot see the palm rests at normal lid angles, so in-air gestures are the
core of this add-on. Desk mode is a prototype until someone checks it on real hardware.

## Pieces

| file | type | camera? | tested |
| --- | --- | --- | --- |
| `CameraSession.swift` | `CameraSession`: AVCaptureSession wrapper | yes, only after `start` | no (never run in tests) |
| `HandTracker.swift` | `HandTracker`: Vision hand pose, max 2 hands, One Euro smoothing | no (takes buffers) | on a synthetic buffer |
| `OneEuroFilter.swift` | `OneEuroFilter`, `HandSmoother` | no | yes |
| `AirGestureRecognizer.swift` | `AirGestureRecognizer`: landmarks in, gestures out | no | yes |
| `DeskSurfaceMapper.swift` | `Homography`, `DeskSurfaceMapper`, `DeskTouchDetector`, `CircleKnob` | no | yes |
| `VisionTypes.swift` | `Point2`, `HandJoint`, `HandLandmarks`, `HandFrame` | no | yes |

Coordinates: landmarks are normalized image coordinates with the origin at the top left and y pointing down. For the
front camera, `HandTracker` mirrors x, so "right" always means the user's right. Deck coordinates follow PROTOCOL:
x runs from 0 (left edge of the base) to 1 (right edge), and y runs from 0 (hinge) to 1 (front lip). Time is in seconds.

## API

```swift
// 1. Camera (daemon only, never in tests). Starting it may show the permission prompt and turns on the green light.
let cam = CameraSession(options: .init())          // kind: .front or .deskView; 640x480; 5 fps idle, 30 fps with a hand
cam.onFrame = { sampleBuffer in ... }              // runs on the capture queue
cam.onStop = { reason in ... }                     // .requested, .timeout, .error, .interrupted
cam.start { error in ... }
cam.setHandPresent(recognizer.handPresent)         // after every frame: switches between 5 and 30 fps
cam.stop()
CameraSession.availableDevices()                   // safe: lists cameras without opening them

// 2. Landmarks
let tracker = HandTracker(options: .init())        // mirrorHorizontally: true for .front, false for .deskView
let frame: HandFrame = try tracker.process(sampleBuffer: sb)   // 21 joints per hand with confidences, smoothed

// 3. Gestures (pure logic)
let recognizer = AirGestureRecognizer(config: AirGestureConfig())
for event in recognizer.process(frame) {
    event.protocolMessage(tMillis:)                // [String: Any] ready for the WebSocket
    event.protocolJSON(tMillis:)                   // the same, as a JSON string
}

// 4. Desk surface (experimental)
let mapper = DeskSurfaceMapper(lidAngleDegrees: 115, family: .macbookPro14)   // geometric first guess
    ?? DeskSurfaceMapper(imageCorners: fourTouchedCorners)                    // or a 4-corner calibration
let tips = mapper.fingertips(of: hand)                                        // [(joint, deck point)]
let touch = DeskTouchDetector(zones: [DeckZone(id: "right-palm", x: 0.6, y: 0.6, w: 0.35, h: 0.35)],
                              contactConfirmer: { zone, t in imuFeltATapRecently(t) ? .confirmed : .unknown })
touch.process(indexTipDeckPoint, t: t)             // -> [DeskTouchEvent] began / ended
let knob = CircleKnob()                            // any y-down 2D stream: deck fingertip, or the air pointer
knob.process(point, t: t)                          // -> [KnobStep] one per 30 degrees, cw or ccw
```

`AirGestureEvent` fields are `t`, `gesture`, `phase` (`instant`, `began`, `changed`, `ended`), `hand` (`left`,
`right`, `unknown`), `confidence`, `position`, `delta`, `total`, and `scale`.

## Gestures

| gesture | kind | how it is recognized |
| --- | --- | --- |
| `air_tap` | discrete | pinch (thumb tip to index tip under 0.25 hand sizes), released within 300 ms, pinch point moved under 0.035 |
| `pinch_hold` | continuous | pinch held still for 250 ms, then streams `changed` events with `delta` (dx, dy) on every move, like a value knob, and `ended` on release |
| `pinch_drag_left` / `_right` / `_up` / `_down` | discrete | pinch, then move at least 0.12 along one axis (1.5 times the other axis) within 1.2 s; fires once per pinch |
| `palm_swipe_left` / `_right` | discrete | open palm (4 fingers out, not pinching) travels at least 0.2 horizontally within 0.45 s at over 0.7 per second |
| `two_hand_zoom` | continuous | both hands pinching; `scale` = current distance between the pinches / starting distance |
| `point` | continuous | index out, other three fingers curled; `position` = index tip mapped from the central 70% of the frame to 0..1 |
| `circle_cw` / `circle_ccw` | discrete, one per step | `CircleKnob`: a step every 30 degrees of turning, the first step after 45 degrees |

A pinch hysteresis stops flicker: the pinch closes under 0.25 and opens only above 0.40 (distances measured in hand
sizes, where hand size is wrist to middle knuckle). Hands are a different size at different distances from the
camera, so every threshold that depends on hand shape is measured in hand sizes. Movement thresholds are measured in
image fractions.

A pinch held longer than 250 ms becomes a hold, so an `air_tap` is effectively a pinch shorter than 250 ms. Only
`tapMaxDuration` (300 ms) applies when `holdDelay` is raised above it.

### How misfires are prevented

- **Confidence gating:** a hand is used only when its mean joint confidence is over 0.6, the wrist, thumb tip, index
  tip and middle knuckle each score at least 0.3, and the hand is not tiny (far away).
- **Activation posture:** a new hand produces nothing until it has been steady for 2 frames (wrist moved less than
  0.15 hand sizes per frame). So a hand passing through the frame, like someone walking by, does nothing.
- **Hand reset:** a hand that enters the frame already pinching has to open before any pinch counts. A pinch that
  fired a drag fires nothing more until it is released. After a swipe, the palm has to slow down or close before
  another swipe counts.
- **Cooldowns:** 250 ms between discrete gestures from the same hand, and 600 ms between swipes. A swipe in the
  opposite direction within 900 ms is treated as the arm coming back and is dropped.
- **Debounce:** pinch and point both need 2 frames to change state.
- **Fist guard:** a closed fist also brings the thumb and index tips together. A pinch counts only when the index
  tip is at least 1.1 hand sizes from the wrist.
- **Zoom priority:** while both hands pinch, neither hand's pinch can become a tap, hold or drag.

All thresholds live in `AirGestureConfig`.

## Proposed PROTOCOL additions

Nothing in `docs/PROTOCOL.md` changes until both sides agree. The proposal:

1. **Gesture names** for the gesture table: `air_tap`, `pinch_hold`, `pinch_drag_left`, `pinch_drag_right`,
   `pinch_drag_up`, `pinch_drag_down`, `palm_swipe_left`, `palm_swipe_right`, `two_hand_zoom`, `point`,
   `circle_cw`, `circle_ccw`. All are snake_case and none clashes with an existing name (a test checks this).
2. **Surface and zone `air`:** discrete air gestures arrive as ordinary `gesture` messages with `"zone": "air"`, so
   bindings work unchanged. The message also carries `hand`, `x` and `y`:
   `{ "type": "gesture", "t": 1234.5, "gesture": "air_tap", "zone": "air", "zones": ["air"], "modifiers": [], "confidence": 0.91, "hand": "right", "x": 0.42, "y": 0.55 }`
3. **New `air` message** for continuous gestures (`pinch_hold`, `two_hand_zoom`, `point`), sent only while
   subscribed to the `air` stream, except for `pinch_hold`, which drives bindings:
   `{ "type": "air", "t": 1234.5, "gesture": "pinch_hold", "phase": "changed", "hand": "right", "x": 0.5, "y": 0.4, "dx": 0.0, "dy": -0.004, "confidence": 0.9 }`
   A binding on `pinch_hold` could use a new `knob` field, for example `{ "axis": "y", "per": 0.02 }`, which repeats
   the bound action once per 0.02 of travel (negative travel runs the binding's `inverse` action).
4. **Desk mode:** a confirmed desk touch becomes a normal `tap` message with an added `"source": "camera"`. Circle
   steps are `gesture` messages `circle_cw` / `circle_ccw` with the deck zone (or `air`) and a `step` index.
5. **Session control:** app to daemon `{ "type": "air_session_start", "camera": "front" | "desk_view", "seconds": 20 }`
   and `{ "type": "air_session_stop" }`. Daemon to app `{ "type": "air_session", "state": "running" | "stopped", "reason": "timeout" }`.
   `hello.sensors` gains `"camera": true` and `hello.permissions` gains `"camera": "authorized" | "denied" | "not_determined"`.
6. **Settings:** `"camera": { "enabled": false, "maxSessionSeconds": 30, "deskMode": false }`.

## How the daemon should integrate

1. **Opening the camera needs user intent.** Start an air session only from an explicit action: the app's
   `air_session_start`, or a bound physical gesture such as a `cover` or a double tap on the lid, if the user chose
   that. Never start one from a timer or at launch. The first `start` shows macOS's camera permission prompt.
2. **The green light.** The camera light turns on for the whole session. That is the privacy signal, and it is the
   reason sessions stay short. `CameraSession` stops by itself at `maxDuration`. The daemon should also stop the
   session after about 10 s with no hand, on `pause`, and on sleep or lid close. Tell the app (`air_session`
   message) so the HUD can show that the camera is on.
3. **Frame loop:** `cam.onFrame` calls `tracker.process`, then `recognizer.process`, then
   `cam.setHandPresent(recognizer.handPresent)`, then sends the events. Run `paused` and binding resolution
   exactly as for tap gestures. Convert `t` to milliseconds since daemon start before sending.
4. **Center Stage** is turned off at session start (`centerStageControlMode = .app`, then disabled), so the image
   does not pan and zoom under the hands.
5. **Battery:** 5 fps while no hand is visible, 30 fps while one is, at 640 px wide. Measured on this M5 Pro
   (debug build): the recognizer takes about 13 µs per frame with two hands, and Vision takes about 2 ms per frame
   on an empty 320x240 frame once warm. Frames that contain hands cost more, and that has not been measured yet. The
   first Vision call loads the model, so make one warm-up call at session start. The main battery cost is the
   camera being on at all. Short sessions matter more than the fps setting.
6. **Desk mode:** feed the lid angle from the sensor hub into `DeskSurfaceMapper`, and rebuild the mapper when the
   angle changes by more than 2 degrees. Use the motion sensor's tap detection as the `contactConfirmer` (confirmed
   when a tap landed within about 150 ms). Without it, a still, hovering finger looks the same as a touch.

## Limitations

- **Desk View geometry is a guess.** Apple does not publish how it warps the Desk View image. `DeskViewCameraModel`
  (90 degree field of view, 25 degree tilt toward the user) is a first guess that has not been checked against the
  real image. With it the model says the whole deck is visible at 115 degrees, which may be false. The research says
  the built-in camera probably cannot see the palm rests at normal lid angles. Use the 4-corner calibration
  (`DeskSurfaceMapper(imageCorners:)`) and check what the image actually shows before trusting desk mode.
- **Touch vs hover is a guess from above.** A camera looking down cannot see height, so "stopped inside a zone" is
  the only signal. Only the motion-sensor confirmation makes it reliable.
- **Tests use synthetic hands.** The thresholds were checked against synthetic landmark streams, not recordings of
  real hands. Before tuning, record real air sessions (landmarks only, no video) with the lab tool.
- **Vision limits:** Vision's hand model struggles in low light, with gloves, with hands partly out of frame, and with
  hands edge-on to the camera. Chirality (left or right hand) is sometimes wrong. The recognizer uses it only as a
  label and a weak matching hint.
- **The front camera image is mirrored by `HandTracker`**, not by the capture connection. Anything that draws the
  raw video must mirror it the same way.
- **SwiftPM warns about this README** as an unhandled file in the target. It is harmless. If the warning bothers
  anyone, add `exclude: ["README.md"]` to the target in `Package.swift`.
