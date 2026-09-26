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
  'tilt_right'
]

/** Gestures that are not tied to a zone at all. */
export const ZONELESS_GESTURES: GestureKind[] = ['lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right']

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

/** Every action except a macro. Macro steps are drawn from these. */
export type SimpleAction =
  | { kind: 'keystroke'; key: string; modifiers: Modifier[] }
  | { kind: 'volume'; step: number }
  | { kind: 'mute' }
  | { kind: 'media'; command: MediaCommand }
  | { kind: 'brightness'; step: number }
  | { kind: 'open'; target: string }
  | { kind: 'shell'; command: string }
  | { kind: 'applescript'; source: string }
  | { kind: 'shortcut'; name: string }
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
  'system'
]

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
}

export interface Settings {
  sensitivity: number
  typingGateMs: number
  doubleWindowMs: number
  minConfidence: number
  hud: boolean
  haptics: boolean
}

export interface Config {
  version: number
  zones: Zone[]
  bindings: Binding[]
  settings: Settings
}

export type Stream = 'imu' | 'lid' | 'light' | 'taps'

// ---------------------------------------------------------------- daemon -> app

export interface HelloMsg {
  type: 'hello'
  version: string
  device: { model: string; chip: string; family: DeviceFamily }
  sensors: { imu: boolean; gyro: boolean; lid: boolean; light: boolean }
  permissions: { accessibility: boolean }
}
export interface StatusMsg {
  type: 'status'
  paused: boolean
  calibrated: boolean
  zones: string[]
  imuHz: number
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
}
export interface RejectedMsg {
  type: 'rejected'
  t: number
  reason: RejectReason
}
export interface GestureMsg {
  type: 'gesture'
  t: number
  gesture: GestureKind
  zone: string | null
  zones: string[] | null
  modifiers: Modifier[]
  confidence: number
  app: string
}
export interface ActionMsg {
  type: 'action'
  t: number
  bindingId: string
  label: string
  ok: boolean
  error: string | null
}
export type CalibrationMsg =
  | { type: 'calibration'; phase: 'capturing'; zone: string; count: number; target: number }
  | { type: 'calibration'; phase: 'negatives'; secondsLeft: number }
  | {
      type: 'calibration'
      phase: 'done'
      accuracy: Record<string, number>
      overall: number
      confusion: number[][]
      labels: string[]
    }
export interface ConfigMsg {
  type: 'config'
  config: Config
}
export interface ErrorMsg {
  type: 'error'
  message: string
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
  /** Sent only after the user approved this exact action in a native dialog (shell, applescript, shortcut, open). */
  | { type: 'approve_action'; action: SimpleAction }

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
  'error'
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
  tilt_right: 'Tilt right'
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
  tilt_right: 'Roll the laptop right and back while holding it'
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
  low_confidence: 'Low confidence',
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
