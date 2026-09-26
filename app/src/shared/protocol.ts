// Typed mirror of docs/PROTOCOL.md. Keep in lockstep with the daemon.

export const DEFAULT_PORT = 47823

export type DeviceFamily = 'macbook-pro-14' | 'macbook-pro-16' | 'macbook-air-13' | 'macbook-air-15'
export const DEVICE_FAMILIES: DeviceFamily[] = ['macbook-pro-14', 'macbook-pro-16', 'macbook-air-13', 'macbook-air-15']

export type Surface = 'base' | 'lid' | 'edge-left' | 'edge-right' | 'front'
export const SURFACES: Surface[] = ['base', 'lid', 'edge-left', 'edge-right', 'front']

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
  /** Default true. A disabled zone is left out of the model and never fires bindings. */
  enabled?: boolean
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
  // sound mode (microphone sessions)
  | 'knock_knuckle'
  | 'rub'
  | 'rub_left'
  | 'rub_right'
  | 'wave_toward'
  | 'wave_away'
  | 'wave_sweep'
  // camera add-on (camera sessions), zone "air"
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
  // stereo sonar (sonar sessions)
  | 'push'
  | 'pull'
  | 'sweep_left'
  | 'sweep_right'
  | 'finger_slide_left'
  | 'finger_slide_right'
  | 'finger_slide_up'
  | 'finger_slide_down'
  | 'hover_level'
  | 'finger_slide'

export const SONAR_GESTURES: GestureKind[] = [
  'hover_level',
  'push',
  'pull',
  'sweep_left',
  'sweep_right',
  'finger_slide',
  'finger_slide_up',
  'finger_slide_down',
  'finger_slide_left',
  'finger_slide_right'
]
/** Sonar gestures that happen in the air (zone "air"); finger slides use the grille zone on that side. */
export const SONAR_AIR_GESTURES: GestureKind[] = ['hover_level', 'push', 'pull', 'sweep_left', 'sweep_right']
/** Continuous gestures that drive a slider. */
export const SLIDER_GESTURES: GestureKind[] = ['hover_level', 'finger_slide']

export const SOUND_GESTURES: GestureKind[] = ['knock_knuckle', 'rub', 'rub_left', 'rub_right', 'wave_toward', 'wave_away', 'wave_sweep']
export const CAMERA_GESTURES: GestureKind[] = [
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

export const GESTURES: GestureKind[] = [
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
  ...SOUND_GESTURES,
  ...SONAR_GESTURES,
  ...CAMERA_GESTURES
]

/** Gestures that are not tied to a tap zone (camera gestures use the pseudo zone "air"). */
export const ZONELESS_GESTURES: GestureKind[] = [
  'lid_nudge',
  'cover',
  'cover_hold',
  'tilt_left',
  'tilt_right',
  'rub',
  'rub_left',
  'rub_right',
  'wave_toward',
  'wave_away',
  'wave_sweep',
  ...SONAR_AIR_GESTURES,
  ...CAMERA_GESTURES
]
export const AIR_ZONE = 'air'

export type Modifier = 'shift' | 'control' | 'option' | 'command' | 'fn'
export const MODIFIERS: Modifier[] = ['control', 'option', 'shift', 'command', 'fn']

export type RejectReason = 'typing' | 'trackpad' | 'motion' | 'low_confidence' | 'burst' | 'paused'

export type MediaCommand = 'playpause' | 'next' | 'previous'

export type WindowOp = 'left' | 'right' | 'top' | 'bottom' | 'maximize' | 'center' | 'next-display' | 'minimize' | 'fullscreen'
export const WINDOW_OPS: WindowOp[] = ['left', 'right', 'top', 'bottom', 'maximize', 'center', 'next-display', 'minimize', 'fullscreen']
export type AppOp = 'hide' | 'quit' | 'switch-next' | 'switch-previous'
export const APP_OPS: AppOp[] = ['hide', 'quit', 'switch-next', 'switch-previous']
export type SystemOp =
  | 'lock'
  | 'sleep-display'
  | 'screenshot'
  | 'screenshot-area'
  | 'dnd-toggle'
  | 'mission-control'
  | 'launchpad'
  | 'show-desktop'
export const SYSTEM_OPS: SystemOp[] = [
  'lock',
  'sleep-display',
  'screenshot',
  'screenshot-area',
  'dnd-toggle',
  'mission-control',
  'launchpad',
  'show-desktop'
]

export type SessionKind = 'sound' | 'sonar' | 'air'
export const SESSION_KINDS: SessionKind[] = ['sound', 'sonar', 'air']
export const SESSION_START = { sound: 'sound_session_start', sonar: 'sonar_session_start', air: 'air_session_start' } as const
export const SESSION_STOP = { sound: 'sound_session_stop', sonar: 'sonar_session_stop', air: 'air_session_stop' } as const
export const SESSION_NAME: Record<SessionKind, string> = { sound: 'Microphone', sonar: 'Sonar', air: 'Camera' }

export type IntegrationArgValue = string | number | boolean

/** Every action except a macro. Macro steps are drawn from these. */
export type SimpleAction =
  | { kind: 'keystroke'; key: string; modifiers: Modifier[] }
  | { kind: 'volume'; step: number }
  | { kind: 'mute' }
  | { kind: 'media'; command: MediaCommand }
  | { kind: 'brightness'; step: number }
  // approvedHash: returned by the daemon after approve_action; any edit to the action drops it.
  | { kind: 'open'; target: string; approvedHash?: string }
  | { kind: 'shell'; command: string; approvedHash?: string }
  | { kind: 'applescript'; source: string; approvedHash?: string }
  | { kind: 'shortcut'; name: string; approvedHash?: string }
  | { kind: 'integration'; app: string; command: string; args: Record<string, IntegrationArgValue> }
  | { kind: 'text'; text: string }
  | { kind: 'clipboard'; text: string }
  | { kind: 'window'; op: WindowOp }
  | { kind: 'app'; op: AppOp }
  | { kind: 'system'; op: SystemOp }

/** A macro step: any simple action, optionally waiting delayMs before it runs. */
export type MacroStep = SimpleAction & { delayMs?: number }

export type Action = SimpleAction | { kind: 'macro'; steps: MacroStep[] }

export const MACRO_MAX_STEPS = 50
export const MACRO_MAX_TOTAL_MS = 30_000

export type ActionKind = Action['kind']
export const ACTION_KINDS: ActionKind[] = [
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
  'system',
  'integration'
]

export interface KnobSpec {
  axis: 'x' | 'y'
  /** Camera pixels of hand movement per step. */
  stepPx: number
  /** Runs for steps in the opposite direction. */
  inverse?: Action | null
}

export interface SliderSpec {
  /** absolute: output follows position since the gesture began; relative: every step counts, like a knob. */
  mode: 'absolute' | 'relative'
  stepMm: number
  /** Runs once per step down (hover: hand lowered; slide: away from the hinge). */
  inverse?: Action | null
}

export interface Binding {
  id: string
  enabled: boolean
  gesture: GestureKind
  zone: string | null
  zones: string[] | null
  modifiers: Modifier[]
  /** "*" for everywhere, or a bundle id. */
  app: string
  action: Action
  label: string
  /** pinch_hold only: turn hand movement into repeated steps. */
  knob?: KnobSpec | null
  /** hover_level / finger_slide only: turn movement into repeated steps. */
  slider?: SliderSpec | null
}

export interface SessionSettings {
  enabled: boolean
  sessionSeconds: number
  /** Bundle ids where a session starts by itself when that app comes to the front. */
  autoApps: string[]
}

export interface Settings {
  sensitivity: number
  typingGateMs: number
  doubleWindowMs: number
  minConfidence: number
  hud: boolean
  haptics: boolean
  /** 0..minConfidence: a weaker tap may complete a double or triple whose other tap was confident. */
  followUpConfidence?: number
  sound?: SessionSettings
  /** Stereo sonar. The tones never play unless enabled. */
  sonar?: SessionSettings
  camera?: SessionSettings & { deskMode: boolean }
}

export interface Config {
  version: number
  zones: Zone[]
  bindings: Binding[]
  settings: Settings
}

export type Stream = 'imu' | 'lid' | 'light' | 'taps' | 'air' | 'debug'

// ---------------------------------------------------------------- daemon -> app

export interface HelloMsg {
  type: 'hello'
  version: string
  device: { model: string; chip: string; family: DeviceFamily }
  sensors: { imu: boolean; gyro: boolean; lid: boolean; light: boolean; sound?: boolean; camera?: boolean }
  permissions: { accessibility: boolean; microphone?: MediaPermission; camera?: MediaPermission }
}
export type MediaPermission = 'authorized' | 'not_determined' | 'denied'
export interface StatusMsg {
  type: 'status'
  paused: boolean
  /** "user" when paused by hand, "rate_limit" when the daemon stopped a runaway burst of actions. */
  pausedReason?: 'user' | 'rate_limit' | null
  calibrated: boolean
  zones: string[]
  imuHz: number
  /** Live tap detector, in milli-g. */
  detector?: { noiseFloorMg: number; thresholdMg: number; level: number }
}
export interface ImuMsg {
  type: 'imu'
  t: number
  a: [number, number, number]
  g: [number, number, number]
}
export interface LidMsg {
  type: 'lid'
  t: number
  angle: number
}
export interface LightMsg {
  type: 'light'
  t: number
  value: number
}
export interface TapMsg {
  type: 'tap'
  t: number
  zone: string
  confidence: number
  x: number
  y: number
  strength: number
  tapType?: 'fingertip' | 'knuckle' | 'nail'
  source?: 'imu' | 'camera'
}
export interface RejectedMsg {
  type: 'rejected'
  t: number
  reason: RejectReason
  /** The classifier's best guess for the dropped tap (only when calibrated). */
  zone?: string | null
  confidence?: number
  /** log10 of the peak in milli-g */
  strength?: number
}
/** "debug" stream: every tap onset the detector analysed, before the gates. */
export interface CandidateMsg {
  type: 'candidate'
  t: number
  zone: string | null
  confidence: number
  strength: number
  outcome: 'accepted' | 'pending' | RejectReason
}
export type FeedbackMsg =
  | {
      type: 'feedback'
      kind: 'missed'
      zone: string
      found: boolean
      retrained: boolean
      reason?: string
      diagnostic?: string
      candidate?: { t: number; zone: string | null; confidence: number; strength: number; droppedBecause: string }
      counts?: Record<string, number>
      overall?: number
    }
  | { type: 'feedback'; kind: 'false'; zone?: string; t?: number; retrained: boolean; reason?: string; counts?: Record<string, number>; overall?: number }
export interface DiagnosticsMsg {
  type: 'diagnostics'
  path: string
  samples: number
  seconds: number
}
export interface Recommendation {
  keep: string[]
  drop: Record<string, string>
  merge: [string, string][]
  expectedAccuracy: Record<string, number>
}
export interface GestureMsg {
  type: 'gesture'
  t: number
  gesture: GestureKind
  zone: string | null
  zones: string[] | null
  modifiers: Modifier[]
  confidence: number
  app: string | null
  hand?: string
  x?: number
  y?: number
  source?: 'imu' | 'sound' | 'camera'
}
export interface ActionMsg {
  type: 'action'
  t: number
  bindingId: string | null
  label: string
  ok: boolean
  error: string | null
}
export type CalibrationMsg =
  | { type: 'calibration'; phase: 'started'; zones: string[]; target: number }
  | { type: 'calibration'; phase: 'training' }
  | { type: 'calibration'; phase: 'cancelled' }
  | { type: 'calibration'; phase: 'capturing'; zone: string; count: number; target: number }
  | { type: 'calibration'; phase: 'negatives'; secondsLeft: number }
  | {
      type: 'calibration'
      phase: 'done'
      accuracy: Record<string, number>
      overall: number
      confusion: number[][]
      labels: string[]
      recommendation?: Recommendation
      /** Tap peak quantiles per zone, in g (requested from the daemon; optional until it sends them). */
      peaks?: Record<string, { p10: number; p50: number; p90: number }>
    }
  | {
      type: 'calibration'
      phase: 'recommendation_applied'
      disabled: string[]
      keep: string[]
      mergeSuggested: [string, string][]
      overall: number
      accuracy: Record<string, number>
      labels: string[]
    }
  | {
      type: 'calibration'
      phase: 'merge_applied'
      zone: string
      name: string
      merged: string[]
      samples: number
      bindingsChanged: { id: string; label: string; gesture: string; from: string; to: string }[]
      conflicts: [string, string][]
      overall: number
      accuracy: Record<string, number>
      labels: string[]
      note?: string
    }
  | { type: 'calibration'; phase: 'taptype_capturing'; tapType: string; count: number; target: number; types: string[] }
export interface ConfigMsg {
  type: 'config'
  config: Config
}
export interface ErrorMsg {
  type: 'error'
  message: string
}
/** Continuous camera gesture: pinch_hold, two_hand_zoom, point. */
export interface AirMsg {
  type: 'air'
  t: number
  phase: 'began' | 'changed' | 'ended'
  gesture: string
  confidence?: number
  hand?: string
  x?: number
  y?: number
  dx?: number
  dy?: number
  scale?: number
  /** sonar */
  side?: 'left' | 'right'
  value?: number
  displacementMm?: number
  dxMm?: number
  dyMm?: number
  cancelled?: boolean
  source?: string
}
export interface SessionMsg {
  type: 'session'
  kind: 'air' | 'sound' | 'sonar'
  /** sonar: the stereo tones are actually playing */
  sonarField?: boolean
  active: boolean
  secondsLeft: number
  reason?: string
  error?: string
  trigger?: string
  simulated?: boolean
}
export interface ApprovedMsg {
  type: 'approved'
  hash: string
  kind: string | null
}
export interface RevokedMsg {
  type: 'revoked'
  hash: string
  found: boolean
}
export interface IntegrationArgSpec {
  name: string
  kind: 'string' | 'number' | 'bool' | 'url' | 'bundleId'
  required: boolean
  defaultValue?: string | null
  help: string
}
export interface IntegrationCommand {
  app: string
  command: string
  title: string
  summary: string
  args: IntegrationArgSpec[]
  destructive: boolean
  undoable: boolean
  automationBundleId?: string | null
  mechanism: 'appleScript' | 'keystrokes' | 'appleScriptAndKeys' | 'native'
  notes?: string | null
}
export interface IntegrationCatalog {
  apps: { key: string; name: string; bundleId?: string | null }[]
  commands: IntegrationCommand[]
  unsupported: Record<string, string>
}
export interface CatalogMsg {
  type: 'catalog'
  catalog: IntegrationCatalog
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
  | AirMsg
  | SessionMsg
  | ApprovedMsg
  | RevokedMsg
  | CatalogMsg
  | CandidateMsg
  | FeedbackMsg
  | DiagnosticsMsg

export type DaemonMessageType = DaemonMessage['type']

// ---------------------------------------------------------------- app -> daemon

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
  | { type: 'test_action'; action: Action }
  | { type: 'request_permission'; which: 'accessibility' }
  /** Sent only by the main process, after the user approved this exact action in a native dialog. */
  | { type: 'approve_action'; action: SimpleAction }
  | { type: 'revoke_action'; hash: string }
  | { type: 'catalog_get' }
  | { type: 'sound_session_start'; seconds?: number }
  | { type: 'sound_session_stop' }
  | { type: 'air_session_start'; seconds?: number }
  | { type: 'air_session_stop' }
  | { type: 'sonar_session_start'; seconds?: number }
  | { type: 'sonar_session_stop' }
  | { type: 'calibration_apply_recommendation' }
  | { type: 'calibration_apply_merge'; zones: [string, string]; name: string }
  | { type: 'feedback_missed'; zone: string }
  | { type: 'feedback_false' }
  | { type: 'diagnostics_export' }

const DAEMON_TYPES: ReadonlySet<string> = new Set([
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
  'air',
  'session',
  'approved',
  'revoked',
  'catalog',
  'candidate',
  'feedback',
  'diagnostics'
])

/** Parses a text frame. Returns null for anything that is not a known daemon message. */
export function parseDaemonMessage(raw: string): DaemonMessage | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v === 'object' && v !== null && 'type' in v && typeof v.type === 'string' && DAEMON_TYPES.has(v.type)) {
      return v as DaemonMessage
    }
  } catch {
    // ignore malformed frames
  }
  return null
}

// ---------------------------------------------------------------- display helpers

export const GESTURE_LABEL: Record<GestureKind, string> = {
  tap: 'Tap',
  double: 'Double tap',
  triple: 'Triple tap',
  sequence: 'Sequence',
  rhythm: 'Rhythm',
  lid_nudge: 'Lid nudge',
  cover: 'Cover sensor',
  cover_hold: 'Cover and hold',
  tilt_left: 'Tilt left',
  tilt_right: 'Tilt right',
  knock_knuckle: 'Knuckle knock',
  rub: 'Rub',
  rub_left: 'Rub left',
  rub_right: 'Rub right',
  wave_toward: 'Wave toward',
  wave_away: 'Wave away',
  wave_sweep: 'Wave across',
  air_tap: 'Air tap',
  pinch_hold: 'Pinch and hold',
  pinch_drag_left: 'Pinch drag left',
  pinch_drag_right: 'Pinch drag right',
  pinch_drag_up: 'Pinch drag up',
  pinch_drag_down: 'Pinch drag down',
  palm_swipe_left: 'Palm swipe left',
  palm_swipe_right: 'Palm swipe right',
  circle_cw: 'Circle clockwise',
  circle_ccw: 'Circle counterclockwise',
  push: 'Push',
  pull: 'Pull',
  sweep_left: 'Sweep left',
  sweep_right: 'Sweep right',
  finger_slide_left: 'Slide left',
  finger_slide_right: 'Slide right',
  finger_slide_up: 'Slide up',
  finger_slide_down: 'Slide down',
  hover_level: 'Hover level',
  finger_slide: 'Slide on the grille'
}

export const GESTURE_HINT: Record<GestureKind, string> = {
  tap: 'One tap in a zone',
  double: 'Two quick taps in the same zone',
  triple: 'Three quick taps',
  sequence: 'A tap in one zone, then another zone within half a second',
  rhythm: 'Tap, short pause, then a double tap',
  lid_nudge: 'Push the lid back a little and let it return',
  cover: 'Briefly cover the light sensor next to the camera',
  cover_hold: 'Cover the light sensor for over a second',
  tilt_left: 'Roll the laptop left and back while holding it',
  tilt_right: 'Roll the laptop right and back while holding it',
  knock_knuckle: 'Knock a zone with a knuckle instead of a fingertip',
  rub: 'Rub a palm rest or grille with a fingertip',
  rub_left: 'Rub or swipe leftward on a palm rest or grille',
  rub_right: 'Rub or swipe rightward on a palm rest or grille',
  wave_toward: 'Move your hand toward the screen, above the keys',
  wave_away: 'Move your hand away from the screen, above the keys',
  wave_sweep: 'Sweep your hand across above the keys',
  air_tap: 'Pinch and release in the air, quickly',
  pinch_hold: 'Pinch and hold, then move your hand to turn it like a knob',
  pinch_drag_left: 'Pinch, move left, release',
  pinch_drag_right: 'Pinch, move right, release',
  pinch_drag_up: 'Pinch, move up, release',
  pinch_drag_down: 'Pinch, move down, release',
  palm_swipe_left: 'Sweep an open palm to the left',
  palm_swipe_right: 'Sweep an open palm to the right',
  circle_cw: 'Draw a circle clockwise with a finger; one step per 30 degrees',
  circle_ccw: 'Draw a circle counterclockwise; one step per 30 degrees',
  push: 'Move a hand quickly down toward a speaker',
  pull: 'Lift a hand quickly up away from a speaker',
  sweep_left: 'Pass a hand across above the keyboard, right to left',
  sweep_right: 'Pass a hand across above the keyboard, left to right',
  finger_slide_left: 'Slide a fingertip left along a grille',
  finger_slide_right: 'Slide a fingertip right along a grille',
  finger_slide_up: 'Slide a fingertip along a grille toward the hinge',
  finger_slide_down: 'Slide a fingertip along a grille toward you',
  hover_level: 'Hold a palm above a speaker and raise or lower it, like a slider',
  finger_slide: 'Slide a fingertip along a grille, like a slider'
}

export const MODIFIER_GLYPH: Record<Modifier, string> = {
  control: '⌃',
  option: '⌥',
  shift: '⇧',
  command: '⌘',
  fn: 'fn'
}

export const REJECT_LABEL: Record<RejectReason, string> = {
  typing: 'Typing',
  trackpad: 'Trackpad',
  motion: 'Motion',
  low_confidence: 'Unsure',
  burst: 'Burst',
  paused: 'Paused'
}

export const SURFACE_LABEL: Record<Surface, string> = {
  base: 'Top case',
  lid: 'Lid',
  'edge-left': 'Left edge',
  'edge-right': 'Right edge',
  front: 'Front lip'
}

export const FAMILY_LABEL: Record<DeviceFamily, string> = {
  'macbook-pro-14': 'MacBook Pro 14-inch',
  'macbook-pro-16': 'MacBook Pro 16-inch',
  'macbook-air-13': 'MacBook Air 13-inch',
  'macbook-air-15': 'MacBook Air 15-inch'
}
