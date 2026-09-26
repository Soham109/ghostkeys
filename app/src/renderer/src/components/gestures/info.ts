import type { GestureKind } from '@shared/protocol'
import type { DemoId } from './scenes'

export type GestureGroup = 'Taps' | 'Motion' | 'Sound' | 'Sonar' | 'Camera'

export interface GestureInfo {
  id: DemoId
  label: string
  how: string
  group: GestureGroup
  /** Where on the Mac it works. */
  surfaces: string
  /** Which Macs, in plain words. */
  macs: string
  /** Needs this piece of hardware in hello.sensors. */
  needs?: 'imu' | 'lid' | 'light' | 'sound' | 'camera' | 'grilles'
  /** Not in the helper yet. */
  coming?: boolean
  pro?: boolean
  /** The binding gesture it maps to, when it is one. */
  gesture?: GestureKind
}

const ALL_MACS = 'MacBook Pro 14 and 16-inch, MacBook Air 13 and 15-inch'

export const GESTURE_INFO: GestureInfo[] = [
  { id: 'tap', gesture: 'tap', label: 'Tap', how: 'One tap with a fingertip.', group: 'Taps', surfaces: 'Every zone', macs: ALL_MACS, needs: 'imu' },
  { id: 'double', gesture: 'double', label: 'Double tap', how: 'Two quick taps in the same zone.', group: 'Taps', surfaces: 'Every zone', macs: ALL_MACS, needs: 'imu' },
  { id: 'triple', gesture: 'triple', label: 'Triple tap', how: 'Three quick taps.', group: 'Taps', surfaces: 'Every zone', macs: ALL_MACS, needs: 'imu' },
  { id: 'rhythm', gesture: 'rhythm', label: 'Rhythm', how: 'Tap, a short pause, then a double tap.', group: 'Taps', surfaces: 'Every zone', macs: ALL_MACS, needs: 'imu', pro: true },
  { id: 'sequence', gesture: 'sequence', label: 'Sequence', how: 'A tap in one zone, then another zone within half a second.', group: 'Taps', surfaces: 'Any two zones', macs: ALL_MACS, needs: 'imu', pro: true },
  { id: 'modifier_tap', label: 'Tap while holding a key', how: 'Hold Shift, Option, Control or Command with one hand and tap with the other.', group: 'Taps', surfaces: 'Every zone', macs: ALL_MACS, needs: 'imu', pro: true },
  { id: 'knock_knuckle', gesture: 'knock_knuckle', label: 'Knuckle knock', how: 'Knock with a knuckle instead of a fingertip. Sound tells the two apart.', group: 'Sound', surfaces: 'Every zone', macs: 'Macs with a built-in microphone', needs: 'sound', pro: true },
  { id: 'rub', gesture: 'rub', label: 'Rub', how: 'Rub a fingertip back and forth.', group: 'Sound', surfaces: 'Palm rests and grilles', macs: 'Macs with a built-in microphone', needs: 'sound', pro: true },
  { id: 'rub_left', gesture: 'rub_left', label: 'Rub left', how: 'Slide a fingertip to the left.', group: 'Sound', surfaces: 'Palm rests and grilles', macs: 'Macs with a built-in microphone', needs: 'sound', pro: true },
  { id: 'rub_right', gesture: 'rub_right', label: 'Rub right', how: 'Slide a fingertip to the right.', group: 'Sound', surfaces: 'Palm rests and grilles', macs: 'Macs with a built-in microphone', needs: 'sound', pro: true },
  { id: 'finger_slide_up', gesture: 'finger_slide_up', label: 'Slide up', how: 'Slide a fingertip up along a speaker grille.', group: 'Sonar', surfaces: 'Speaker grilles', macs: 'MacBook Pro 14 and 16-inch', needs: 'grilles', pro: true },
  { id: 'finger_slide_down', gesture: 'finger_slide_down', label: 'Slide down', how: 'Slide a fingertip down along a speaker grille.', group: 'Sonar', surfaces: 'Speaker grilles', macs: 'MacBook Pro 14 and 16-inch', needs: 'grilles', pro: true },
  { id: 'finger_slide_left', gesture: 'finger_slide_left', label: 'Slide left', how: 'Slide a fingertip left along a speaker grille.', group: 'Sonar', surfaces: 'Speaker grilles', macs: 'MacBook Pro 14 and 16-inch', needs: 'grilles', pro: true },
  { id: 'finger_slide_right', gesture: 'finger_slide_right', label: 'Slide right', how: 'Slide a fingertip right along a speaker grille.', group: 'Sonar', surfaces: 'Speaker grilles', macs: 'MacBook Pro 14 and 16-inch', needs: 'grilles', pro: true },
  { id: 'hover_level', gesture: 'hover_level', label: 'Hover level', how: 'Hold a palm above a speaker and raise or lower it, like a slider in the air.', group: 'Sonar', surfaces: 'Above the speakers', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'push', gesture: 'push', label: 'Push', how: 'Move an open hand toward the screen above the keys.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'pull', gesture: 'pull', label: 'Pull', how: 'Draw an open hand back toward you above the keys.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'sweep_left', gesture: 'sweep_left', label: 'Sweep left', how: 'Sweep a hand to the left, just above the deck.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'sweep_right', gesture: 'sweep_right', label: 'Sweep right', how: 'Sweep a hand to the right, just above the deck.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'wave_toward', gesture: 'wave_toward', label: 'Wave toward', how: 'A quick wave toward the screen above the keys.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'wave_away', gesture: 'wave_away', label: 'Wave away', how: 'A quick wave back toward you.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'wave_sweep', gesture: 'wave_sweep', label: 'Wave across', how: 'Sweep a hand across above the keys.', group: 'Sonar', surfaces: 'Above the keyboard', macs: 'Built-in stereo speakers and microphone; never with headphones', needs: 'sound', pro: true },
  { id: 'lid_nudge', gesture: 'lid_nudge', label: 'Lid nudge', how: 'Push the top of the lid back a little and let it return.', group: 'Motion', surfaces: 'The lid', macs: 'Macs with a lid angle sensor', needs: 'lid', pro: true },
  { id: 'cover', gesture: 'cover', label: 'Cover sensor', how: 'Briefly cover the light sensor beside the camera.', group: 'Motion', surfaces: 'Light sensor, top of the screen', macs: 'Macs with an ambient light sensor', needs: 'light', pro: true },
  { id: 'cover_hold', gesture: 'cover_hold', label: 'Cover and hold', how: 'Keep the light sensor covered for over a second.', group: 'Motion', surfaces: 'Light sensor, top of the screen', macs: 'Macs with an ambient light sensor', needs: 'light', pro: true },
  { id: 'tilt_left', gesture: 'tilt_left', label: 'Tilt left', how: 'Hold the Mac and roll it left, then back.', group: 'Motion', surfaces: 'The whole Mac', macs: ALL_MACS, needs: 'imu', pro: true },
  { id: 'tilt_right', gesture: 'tilt_right', label: 'Tilt right', how: 'Hold the Mac and roll it right, then back.', group: 'Motion', surfaces: 'The whole Mac', macs: ALL_MACS, needs: 'imu', pro: true },
  { id: 'air_tap', gesture: 'air_tap', label: 'Air tap', how: 'Pinch thumb and index together and let go, quickly.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'pinch_hold', gesture: 'pinch_hold', label: 'Pinch and hold', how: 'Pinch, hold, and move your hand up or down to turn it like a dial.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'pinch_drag_left', gesture: 'pinch_drag_left', label: 'Pinch drag left', how: 'Pinch, move left, release.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'pinch_drag_right', gesture: 'pinch_drag_right', label: 'Pinch drag right', how: 'Pinch, move right, release.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'pinch_drag_up', gesture: 'pinch_drag_up', label: 'Pinch drag up', how: 'Pinch, move up, release.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'pinch_drag_down', gesture: 'pinch_drag_down', label: 'Pinch drag down', how: 'Pinch, move down, release.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'palm_swipe_left', gesture: 'palm_swipe_left', label: 'Palm swipe left', how: 'Sweep an open palm to the left.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'palm_swipe_right', gesture: 'palm_swipe_right', label: 'Palm swipe right', how: 'Sweep an open palm to the right.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'circle_cw', gesture: 'circle_cw', label: 'Circle clockwise', how: 'Draw a circle with a fingertip; each twelfth of a turn is one step.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'circle_ccw', gesture: 'circle_ccw', label: 'Circle counterclockwise', how: 'Draw a circle the other way.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'two_hand_zoom', label: 'Two-hand zoom', how: 'Pinch with both hands and pull them apart, or push them together.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true },
  { id: 'point', label: 'Point', how: 'Point at the screen; the fingertip becomes a pointer.', group: 'Camera', surfaces: 'In front of the camera', macs: 'Any Mac with a camera', needs: 'camera', pro: true }
]

export const GROUP_ORDER: GestureGroup[] = ['Taps', 'Motion', 'Sound', 'Sonar', 'Camera']

export function infoFor(id: string): GestureInfo | undefined {
  return GESTURE_INFO.find((g) => g.id === id)
}
