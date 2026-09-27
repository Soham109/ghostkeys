/**
 * Typed mirror of docs/PROTOCOL.md, kept honest against the daemon source
 * (daemon/Sources/ghostkeysd/App/Daemon.swift, Config/Config.swift, Server/WebSocketServer.swift).
 *
 * A few things the protocol doc's prose glosses over, confirmed by reading the daemon:
 *   - `calibration` has three more phases than the doc's jsonc sample shows: "started" (reply to
 *     calibration_start), "training" (between calibration_finish and "done"), and "cancelled"
 *     (reply to calibration_cancel).
 *   - `status` is broadcast unprompted every 5 seconds (a housekeeping timer), not only after
 *     pause/resume/config_set.
 *   - `tap` and `rejected` are only sent to clients subscribed to the "taps" stream. `imu`/`lid`/
 *     `light` are likewise gated behind their own stream subscriptions. `gesture`, `action`,
 *     `calibration`, `status`, `config`, `hello` and `error` are NOT stream-gated: every connected
 *     client gets them regardless of subscribe/unsubscribe.
 *   - `gesture.app` and `action.bindingId` are nullable (the daemon sends JSON null when there is
 *     no frontmost bundle id, or when the action came from `test_action` rather than a binding).
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 47823
export const DEFAULT_URL = `ws://127.0.0.1:${DEFAULT_PORT}/`

export type DeviceFamily = 'macbook-pro-14' | 'macbook-pro-16' | 'macbook-air-13' | 'macbook-air-15'
export const DEVICE_FAMILIES: readonly DeviceFamily[] = [
  'macbook-pro-14',
  'macbook-pro-16',
  'macbook-air-13',
  'macbook-air-15'
]

export type Surface = 'base' | 'lid' | 'edge-left' | 'edge-right' | 'front'
export const SURFACES: readonly Surface[] = ['base', 'lid', 'edge-left', 'edge-right', 'front']

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Zone {
  id: string
  name: string
  surface: Surface
  rect: Rect
  color: string
}

export type GestureKind =
  | 'tap'
  | 'double'
  | 'triple'
  | 'sequence'
  | 'rhythm'
  | 'lid_nudge'
  | 'cover'
  | 'cover_hold'
  | 'tilt_left'
  | 'tilt_right'
  // Optional sound mode (GhostkeysAcoustics, mic sessions only).
  | 'knock_knuckle'
  | 'rub'
  | 'rub_left'
  | 'rub_right'
  | 'wave_toward'
  | 'wave_away'
  | 'wave_sweep'
  // Optional camera add-on (GhostkeysVision, camera sessions only). Sent with zone "air".
  | 'air_tap'
  | 'pinch_hold'
  | 'pinch_drag_left'
  | 'pinch_drag_right'
  | 'pinch_drag_up'
  | 'pinch_drag_down'
  | 'palm_swipe_left'
  | 'palm_swipe_right'
  | 'circle_cw'
  | 'circle_ccw'

export const GESTURES: readonly GestureKind[] = [
  'tap',
  'double',
  'triple',
  'sequence',
  'rhythm',
  'lid_nudge',
  'cover',
  'cover_hold',
  'tilt_left',
  'tilt_right',
  'knock_knuckle',
  'rub',
  'rub_left',
  'rub_right',
  'wave_toward',
  'wave_away',
  'wave_sweep',
  'air_tap',
  'pinch_hold',
  'pinch_drag_left',
  'pinch_drag_right',
  'pinch_drag_up',
  'pinch_drag_down',
  'palm_swipe_left',
  'palm_swipe_right',
  'circle_cw',
  'circle_ccw'
]

/** Gestures that never carry a single `zone` (lid/light/motion gestures aren't tied to a tap zone). */
export const ZONELESS_GESTURES: readonly GestureKind[] = ['lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right']

/** The only gesture that reports two zones (`zones`) instead of one (`zone`). */
export const MULTI_ZONE_GESTURES: readonly GestureKind[] = ['sequence']

/** Gestures whose bindings need the engine to wait for more taps before resolving (see Config.swift). */
export const MULTI_TAP_GESTURES: readonly GestureKind[] = ['double', 'triple', 'rhythm']

/** Optional sound mode (mic sessions only). Matches Config.soundGestures. */
export const SOUND_GESTURES: readonly GestureKind[] = ['knock_knuckle', 'rub', 'rub_left', 'rub_right', 'wave_toward', 'wave_away', 'wave_sweep']
export const WAVE_GESTURES: readonly GestureKind[] = ['wave_toward', 'wave_away', 'wave_sweep']

/** Optional camera add-on discrete gestures (camera sessions only), reported as "gesture" messages with zone "air". */
export const CAMERA_GESTURES: readonly GestureKind[] = [
  'air_tap',
  'pinch_hold',
  'pinch_drag_left',
  'pinch_drag_right',
  'pinch_drag_up',
  'pinch_drag_down',
  'palm_swipe_left',
  'palm_swipe_right',
  'circle_cw',
  'circle_ccw'
]

/** Continuous camera gestures: these arrive as `air` messages (phase began/changed/ended), never as `gesture`. */
export type ContinuousAirGesture = 'pinch_hold' | 'two_hand_zoom' | 'point'
export const CONTINUOUS_AIR_GESTURES: readonly ContinuousAirGesture[] = ['pinch_hold', 'two_hand_zoom', 'point']

export type Modifier = 'shift' | 'control' | 'option' | 'command' | 'fn'
export const MODIFIERS: readonly Modifier[] = ['control', 'option', 'shift', 'command', 'fn']

export type RejectReason = 'typing' | 'trackpad' | 'motion' | 'low_confidence' | 'burst' | 'paused'
export const REJECT_REASONS: readonly RejectReason[] = ['typing', 'trackpad', 'motion', 'low_confidence', 'burst', 'paused']

export type Stream = 'imu' | 'lid' | 'light' | 'taps' | 'air'
export const STREAMS: readonly Stream[] = ['imu', 'lid', 'light', 'taps', 'air']

/** "authorized" | "denied" | "not_determined": AVFoundation authorization status, stringified. */
export type PermissionState = 'authorized' | 'denied' | 'not_determined'
export const PERMISSION_STATES: readonly PermissionState[] = ['authorized', 'denied', 'not_determined']

/** Where a tap or gesture was recognized from. */
export type InputSource = 'imu' | 'sound' | 'camera'
export const INPUT_SOURCES: readonly InputSource[] = ['imu', 'sound', 'camera']

export type TapType = 'fingertip' | 'knuckle' | 'nail'
export const TAP_TYPES: readonly TapType[] = ['fingertip', 'knuckle', 'nail']

// ---------------------------------------------------------------------------
// Actions (config file + test_action)
// ---------------------------------------------------------------------------

export type MediaCommand = 'playpause' | 'next' | 'previous'
export const MEDIA_COMMANDS: readonly MediaCommand[] = ['playpause', 'next', 'previous']

export type WindowOp =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'maximize'
  | 'center'
  | 'next-display'
  | 'minimize'
  | 'fullscreen'
export const WINDOW_OPS: readonly WindowOp[] = [
  'left',
  'right',
  'top',
  'bottom',
  'maximize',
  'center',
  'next-display',
  'minimize',
  'fullscreen'
]

export type AppOp = 'hide' | 'quit' | 'switch-next' | 'switch-previous'
export const APP_OPS: readonly AppOp[] = ['hide', 'quit', 'switch-next', 'switch-previous']

export type SystemOp =
  | 'lock'
  | 'sleep-display'
  | 'screenshot'
  | 'screenshot-area'
  | 'dnd-toggle'
  | 'mission-control'
  | 'launchpad'
  | 'show-desktop'
export const SYSTEM_OPS: readonly SystemOp[] = [
  'lock',
  'sleep-display',
  'screenshot',
  'screenshot-area',
  'dnd-toggle',
  'mission-control',
  'launchpad',
  'show-desktop'
]

/** Apps PROTOCOL.md names as examples for `integration`. The daemon accepts any string here. */
export type IntegrationApp =
  | 'excel'
  | 'chrome'
  | 'safari'
  | 'arc'
  | 'music'
  | 'spotify'
  | 'finder'
  | 'powerpoint'
  | 'keynote'
  | 'zoom'
export const INTEGRATION_APPS: readonly IntegrationApp[] = [
  'excel',
  'chrome',
  'safari',
  'arc',
  'music',
  'spotify',
  'finder',
  'powerpoint',
  'keynote',
  'zoom'
]

/**
 * `open`, `shell`, `applescript` and `shortcut` are "gated": the daemon only runs them once they
 * carry `approvedHash` and that hash is listed in its approved.json (see PROTOCOL.md
 * "Authentication" / ApprovalStore.swift). `approvedHash` is the SHA-256 of the action's canonical
 * JSON (without approvedHash/label/delayMs), computed and returned only by the daemon in reply to
 * `approve_action`; a client should never fabricate one.
 */
export interface Approvable {
  approvedHash?: string
}

/** Every action except `macro`. Macro steps are drawn from this set. */
export type SimpleAction =
  | { kind: 'keystroke'; key: string; modifiers: Modifier[] }
  | { kind: 'volume'; step: number }
  | { kind: 'mute' }
  | { kind: 'media'; command: MediaCommand }
  | { kind: 'brightness'; step: number }
  | ({ kind: 'open'; target: string } & Approvable)
  | ({ kind: 'shell'; command: string } & Approvable)
  | ({ kind: 'applescript'; source: string } & Approvable)
  | ({ kind: 'shortcut'; name: string } & Approvable)
  | { kind: 'text'; text: string }
  | { kind: 'clipboard'; text: string }
  | { kind: 'window'; op: WindowOp }
  | { kind: 'app'; op: AppOp }
  | { kind: 'integration'; app: string; command: string; args?: Record<string, unknown> }
  | { kind: 'system'; op: SystemOp }

/** A macro step: any simple action, optionally waiting `delayMs` before it runs. */
export type MacroStep = SimpleAction & { delayMs?: number }

export type Action = SimpleAction | { kind: 'macro'; steps: MacroStep[] }

export const MACRO_MAX_STEPS = 50
export const MACRO_MAX_TOTAL_MS = 30_000

/** Action kinds the daemon refuses to run without approval: open, shell, applescript, shortcut. */
export const APPROVAL_GATED_KINDS: readonly ActionKind[] = ['open', 'shell', 'applescript', 'shortcut']

/** Every action inside `action` that needs approval: itself if it's a gated kind, or its gated macro steps. */
export function actionsNeedingApproval(action: Action): SimpleAction[] {
  const gated = new Set<string>(APPROVAL_GATED_KINDS)
  if (action.kind === 'macro') return action.steps.filter((s) => gated.has(s.kind))
  return gated.has(action.kind) ? [action] : []
}

export type ActionKind = Action['kind']
export const ACTION_KINDS: readonly ActionKind[] = [
  'keystroke',
  'volume',
  'mute',
  'media',
  'brightness',
  'open',
  'shell',
  'applescript',
  'shortcut',
  'text',
  'macro',
  'clipboard',
  'window',
  'app',
  'integration',
  'system'
]

/** What `test_action` accepts: an action, plus an optional label the daemon uses only for its `action.label` echo. */
export type TestActionInput = Action & { label?: string }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** `pinch_hold` knob mode: while held, the bound action fires once per `stepPx` of travel along `axis`
 * (camera pixels at 640x480). Positive travel runs `action` (right for x, up for y); the other way runs `inverse`. */
export interface KnobSpec {
  axis: 'x' | 'y'
  stepPx: number
  inverse?: Action | null
}

export interface Binding {
  id: string
  enabled: boolean
  gesture: GestureKind
  zone: string | null
  zones: string[] | null
  modifiers: Modifier[]
  /** "*" for every app, or a bundle id. App-specific bindings win over "*". */
  app: string
  action: Action
  label?: string | null
  /** Only meaningful for a `pinch_hold` binding. */
  knob?: KnobSpec | null
}

/** Optional sound mode (GhostkeysAcoustics). Off by default; the mic opens only in short sessions. */
export interface SoundSettings {
  enabled: boolean
  sessionSeconds: number
  /** Bundle ids where a session starts by itself when the app comes to the front (needs a sound binding too). */
  autoApps: string[]
}

/** Optional camera add-on (GhostkeysVision). Off by default; the camera runs only in short sessions. */
export interface CameraSettings {
  enabled: boolean
  sessionSeconds: number
  autoApps: string[]
  /** Experimental Desk View mode (fingertips on the deck). */
  deskMode: boolean
}

export interface Settings {
  sensitivity: number
  typingGateMs: number
  doubleWindowMs: number
  minConfidence: number
  /** A tap at this confidence may complete a double or triple in the same zone. */
  followUpConfidence?: number
  lightTouch?: boolean
  hud: boolean
  haptics: boolean
  sound: SoundSettings
  camera: CameraSettings
  /**
   * Stereo sonar. The tones never play unless enabled; while enabled it runs continuously until turned off
   * (sessionSeconds and autoApps are ignored).
   */
  sonar?: SoundSettings
}

export interface Config {
  version: number
  zones: Zone[]
  bindings: Binding[]
  settings: Settings
}

// ---------------------------------------------------------------------------
// Daemon -> app
// ---------------------------------------------------------------------------

export interface HelloMsg {
  type: 'hello'
  version: string
  device: { model: string; chip: string; family: DeviceFamily | string }
  /** sound / camera: the hardware exists, checked without opening the mic or camera. */
  sensors: { imu: boolean; gyro: boolean; lid: boolean; light: boolean; sound: boolean; camera: boolean }
  permissions: { accessibility: boolean; microphone: PermissionState; camera: PermissionState }
}

export interface DetectorState {
  noiseFloorMg: number
  thresholdMg: number
  level: number
}

export interface StatusMsg {
  type: 'status'
  paused: boolean
  /** Why the daemon is paused. Null when running. */
  pausedReason: 'user' | 'rate_limit' | null
  calibrated: boolean
  zones: string[]
  imuHz: number
  /** Live onset detector state, all in milli-g. */
  detector: DetectorState
}

/** Only sent to clients subscribed to the "imu" stream, decimated to ~60 Hz. */
export interface ImuMsg {
  type: 'imu'
  t: number
  a: [number, number, number]
  g: [number, number, number]
}

/** Only sent to clients subscribed to the "lid" stream, on change. */
export interface LidMsg {
  type: 'lid'
  t: number
  angle: number
}

/** Only sent to clients subscribed to the "light" stream, at most ~11 Hz. */
export interface LightMsg {
  type: 'light'
  t: number
  value: number
}

/** Only sent to clients subscribed to the "taps" stream: every accepted tap. */
export interface TapMsg {
  type: 'tap'
  t: number
  zone: string
  confidence: number
  x: number
  y: number
  strength: number
  /** "imu" (the default path) or "camera" (GhostkeysVision Desk View). Absent on older daemons. */
  source?: InputSource
  /** Set only when a sound session classified the tap; absent otherwise. */
  tapType?: TapType
}

/** Only sent to clients subscribed to the "taps" stream: a candidate the engine threw out. */
export interface RejectedMsg {
  type: 'rejected'
  t: number
  reason: RejectReason
  /** Set for a sound-mode gesture suppressed by the typing gate (e.g. a rub mistaken for typing noise). */
  gesture?: string
}

/** Not stream-gated: every connected client gets every accepted gesture. */
export interface GestureMsg {
  type: 'gesture'
  t: number
  gesture: GestureKind
  /** "air" for a camera gesture. */
  zone: string | null
  zones: string[] | null
  modifiers: Modifier[]
  confidence: number
  app: string | null
  /** Camera gestures only. */
  hand?: 'left' | 'right'
  x?: number
  y?: number
  /** "sound" or "camera" when the gesture did not come from the IMU. */
  source?: InputSource
}

/** Not stream-gated. `bindingId` is null for actions fired by `test_action`. */
export interface ActionMsg {
  type: 'action'
  t: number
  bindingId: string | null
  label: string
  ok: boolean
  error: string | null
}

export type CalibrationPhase =
  | 'started'
  | 'capturing'
  | 'negatives'
  | 'training'
  | 'done'
  | 'cancelled'
  | 'taptype_capturing'
  | 'taptype_cancelled'
  | 'taptype_training'
  | 'taptype_done'
  | 'taptype_failed'

export type CalibrationMsg =
  | { type: 'calibration'; phase: 'started'; zones: string[]; target: number }
  | { type: 'calibration'; phase: 'capturing'; zone: string; count: number; target: number }
  | { type: 'calibration'; phase: 'negatives'; secondsLeft: number }
  | { type: 'calibration'; phase: 'training' }
  | {
      type: 'calibration'
      phase: 'done'
      accuracy: Record<string, number>
      overall: number
      confusion: number[][]
      labels: string[]
    }
  | { type: 'calibration'; phase: 'cancelled' }
  // Tap-type (sound mode) calibration: calibration_taptype_start / calibration_taptype_cancel.
  | { type: 'calibration'; phase: 'taptype_capturing'; tapType: string; count: number; target: number; types: string[]; missed?: boolean }
  | { type: 'calibration'; phase: 'taptype_cancelled'; reason: string }
  | { type: 'calibration'; phase: 'taptype_training' }
  | {
      type: 'calibration'
      phase: 'taptype_done'
      accuracy: number
      counts: Record<string, number>
      types: string[]
      simulated?: boolean
    }
  | { type: 'calibration'; phase: 'taptype_failed'; error: string }

export type CalibrationDoneMsg = Extract<CalibrationMsg, { phase: 'done' }>

/** Not stream-gated: sent as the reply to config_get/config_set, and broadcast to everyone on config_set. */
export interface ConfigMsg {
  type: 'config'
  config: Config
}

export interface ErrorMsg {
  type: 'error'
  message: string
}

/** Reply to `approve_action`, sent only to the requester. */
export interface ApprovedMsg {
  type: 'approved'
  hash: string
  kind: string | null
}

/** Reply to `revoke_action`, sent only to the requester. */
export interface RevokedMsg {
  type: 'revoked'
  hash: string
  found: boolean
}

/** Opaque catalog of integration apps/commands (GhostkeysIntegrations.IntegrationCatalog.json). Reply to catalog_get. */
export interface IntegrationCatalog {
  apps?: unknown[]
  commands?: unknown[]
  unsupported?: Record<string, unknown>
  [key: string]: unknown
}

export interface CatalogMsg {
  type: 'catalog'
  catalog: IntegrationCatalog
}

/** Optional sound (mic) or camera session state. Broadcast on every change, and to a client whose request failed. */
export interface SessionMsg {
  type: 'session'
  /** "sonar" has no timer: it is active while settings.sonar.enabled is true (continuous, secondsLeft 0). */
  kind: 'sound' | 'sonar' | 'air'
  active: boolean
  secondsLeft: number
  simulated?: boolean
  reason?: string
  trigger?: string
  /** "sound" sessions only. */
  sonar?: boolean
  tapTypes?: boolean
  error?: string
  /** sonar: the stereo tones are playing */
  sonarField?: boolean
  continuous?: boolean
  enabled?: boolean
  /** sonar: enabled but held ("paused", "asleep", "display_asleep", "lid_closed"); resumes by itself */
  waiting?: string
  /** sonar: why the tones are off while the microphone is open */
  tonesOff?: string
  /** sound: not started because sonar is on and covers it */
  coveredBy?: string
}

/**
 * Continuous camera gestures only when a session is active: subscribe to the "air" stream.
 * Discrete camera gestures (air_tap, palm_swipe_*, circle_*) arrive as ordinary `gesture` messages instead.
 */
export interface AirMsg {
  type: 'air'
  t: number
  /** Camera gestures, or the continuous sonar values hover_level / finger_slide (source "sonar"). */
  gesture: ContinuousAirGesture | 'hover_level' | 'finger_slide'
  phase: 'began' | 'changed' | 'ended'
  hand?: 'left' | 'right'
  x?: number
  y?: number
  dx?: number
  dy?: number
  scale?: number
  confidence?: number
  /** sonar only */
  side?: 'left' | 'right'
  value?: number
  displacementMm?: number
  dxMm?: number
  dyMm?: number
  cancelled?: boolean
  source?: string
}

export type DaemonMessage =
  | HelloMsg
  | StatusMsg
  | ImuMsg
  | LidMsg
  | LightMsg
  | TapMsg
  | RejectedMsg
  | GestureMsg
  | ActionMsg
  | CalibrationMsg
  | ConfigMsg
  | ErrorMsg
  | ApprovedMsg
  | RevokedMsg
  | CatalogMsg
  | SessionMsg
  | AirMsg

export type DaemonMessageType = DaemonMessage['type']

export const DAEMON_MESSAGE_TYPES: readonly DaemonMessageType[] = [
  'hello',
  'status',
  'imu',
  'lid',
  'light',
  'tap',
  'rejected',
  'gesture',
  'action',
  'calibration',
  'config',
  'error',
  'approved',
  'revoked',
  'catalog',
  'session',
  'air'
]

/** Narrows `DaemonMessage` to the variant(s) whose `type` field is `T`. */
export type DaemonMessageOf<T extends DaemonMessageType> = Extract<DaemonMessage, { type: T }>

// ---------------------------------------------------------------------------
// App -> daemon
// ---------------------------------------------------------------------------

export type AppMessage =
  | { type: 'subscribe'; streams: Stream[] }
  | { type: 'unsubscribe'; streams: Stream[] }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'calibration_start'; zones: string[]; target: number }
  | { type: 'calibration_zone'; zone: string }
  | { type: 'calibration_negatives'; seconds: number }
  | { type: 'calibration_finish' }
  | { type: 'calibration_cancel' }
  | { type: 'config_get' }
  | { type: 'config_set'; config: Config }
  | { type: 'test_action'; action: TestActionInput }
  | { type: 'request_permission'; which: 'accessibility' }
  /** Only after the user confirmed natively; see docs/PROTOCOL.md "Authentication". */
  | { type: 'approve_action'; action: Action }
  | { type: 'revoke_action'; hash: string }
  | { type: 'revoke_action'; action: Action }
  | { type: 'catalog_get' }
  | { type: 'sound_session_start'; seconds?: number }
  | { type: 'sound_session_stop' }
  | { type: 'air_session_start'; seconds?: number; camera?: string }
  | { type: 'air_session_stop' }
  | { type: 'calibration_taptype_start'; types?: string[]; target?: number }
  | { type: 'calibration_taptype_cancel' }

export type AppMessageType = AppMessage['type']
