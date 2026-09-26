import type { Action, ActionKind, AppOp, MediaCommand, Modifier, SimpleAction, SystemOp, WindowOp } from './protocol'
import { MODIFIER_GLYPH } from './protocol'

export const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  keystroke: 'Keyboard shortcut',
  volume: 'Volume',
  mute: 'Mute',
  media: 'Media control',
  brightness: 'Brightness',
  open: 'Open app, file or link',
  shell: 'Shell command',
  applescript: 'AppleScript',
  shortcut: 'Run a Shortcut',
  text: 'Type text',
  macro: 'Macro',
  clipboard: 'Copy to clipboard',
  window: 'Arrange window',
  app: 'Control app',
  system: 'System command'
}

export const MEDIA_LABEL: Record<MediaCommand, string> = {
  playpause: 'Play or pause',
  next: 'Next track',
  previous: 'Previous track'
}

export const WINDOW_LABEL: Record<WindowOp, string> = {
  left: 'Left half',
  right: 'Right half',
  top: 'Top half',
  bottom: 'Bottom half',
  maximize: 'Fill screen',
  center: 'Center',
  'next-display': 'Move to next display',
  minimize: 'Minimize',
  fullscreen: 'Toggle full screen'
}

export const APP_LABEL: Record<AppOp, string> = {
  hide: 'Hide frontmost app',
  quit: 'Quit frontmost app',
  'switch-next': 'Switch to next app',
  'switch-previous': 'Switch to previous app'
}

export const SYSTEM_LABEL: Record<SystemOp, string> = {
  lock: 'Lock screen',
  'sleep-display': 'Sleep display',
  screenshot: 'Screenshot',
  'screenshot-area': 'Screenshot of an area',
  'dnd-toggle': 'Toggle Do Not Disturb',
  'mission-control': 'Mission Control',
  launchpad: 'Launchpad',
  'show-desktop': 'Show desktop'
}

const KEY_GLYPH: Record<string, string> = {
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  return: '↩',
  enter: '⌅',
  tab: '⇥',
  space: 'Space',
  escape: 'esc',
  delete: '⌫',
  forwarddelete: '⌦',
  home: '↖',
  end: '↘',
  pageup: '⇞',
  pagedown: '⇟'
}

const MOD_ORDER: Modifier[] = ['fn', 'control', 'option', 'shift', 'command']

export function sortModifiers(mods: Modifier[]): Modifier[] {
  return MOD_ORDER.filter((m) => mods.includes(m))
}

export function keyGlyph(key: string): string {
  return KEY_GLYPH[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase())
}

export function comboText(key: string, mods: Modifier[]): string {
  return sortModifiers(mods)
    .map((m) => MODIFIER_GLYPH[m])
    .join('') + keyGlyph(key)
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

/** Short human summary of an action, used for default labels and table rows. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'keystroke':
      return `Press ${comboText(a.key, a.modifiers)}`
    case 'volume':
      return a.step >= 0 ? `Volume up ${a.step}%` : `Volume down ${Math.abs(a.step)}%`
    case 'mute':
      return 'Mute or unmute'
    case 'media':
      return MEDIA_LABEL[a.command]
    case 'brightness':
      return `Brightness ${signed(a.step)}`
    case 'open':
      return a.target ? `Open ${a.target}` : 'Open'
    case 'shell':
      return a.command ? `Run ${a.command.split('\n')[0]}` : 'Run shell command'
    case 'applescript':
      return 'Run AppleScript'
    case 'shortcut':
      return a.name ? `Run Shortcut ${a.name}` : 'Run Shortcut'
    case 'text':
      return a.text ? `Type ${JSON.stringify(a.text.length > 24 ? a.text.slice(0, 24) + '…' : a.text)}` : 'Type text'
    case 'clipboard':
      return 'Copy text to clipboard'
    case 'window':
      return WINDOW_LABEL[a.op]
    case 'app':
      return APP_LABEL[a.op]
    case 'system':
      return SYSTEM_LABEL[a.op]
    case 'macro':
      return `Macro, ${a.steps.length} ${a.steps.length === 1 ? 'step' : 'steps'}`
  }
}

export function defaultAction(kind: ActionKind): Action {
  switch (kind) {
    case 'keystroke':
      return { kind, key: 'v', modifiers: ['command'] }
    case 'volume':
      return { kind, step: 6 }
    case 'mute':
      return { kind }
    case 'media':
      return { kind, command: 'playpause' }
    case 'brightness':
      return { kind, step: 1 }
    case 'open':
      return { kind, target: '' }
    case 'shell':
      return { kind, command: '' }
    case 'applescript':
      return { kind, source: 'display notification "Hello from Ghostkeys"' }
    case 'shortcut':
      return { kind, name: '' }
    case 'text':
      return { kind, text: '' }
    case 'clipboard':
      return { kind, text: '' }
    case 'window':
      return { kind, op: 'left' }
    case 'app':
      return { kind, op: 'switch-next' }
    case 'system':
      return { kind, op: 'lock' }
    case 'macro':
      return { kind, steps: [] }
  }
}

export function isDestructive(a: Action): boolean {
  if (a.kind === 'app' && a.op === 'quit') return true
  if (a.kind === 'macro') return a.steps.some((s) => s.kind === 'app' && s.op === 'quit')
  return false
}

// ---------------------------------------------------------------- presets

export type PresetCategory = 'Media' | 'Window' | 'System' | 'Apps' | 'Excel and Sheets' | 'Browser' | 'Dev' | 'Writing'

export const PRESET_CATEGORIES: PresetCategory[] = [
  'Media',
  'Window',
  'System',
  'Apps',
  'Excel and Sheets',
  'Browser',
  'Dev',
  'Writing'
]

export interface Preset {
  id: string
  name: string
  /** One of PRESET_CATEGORIES for the built-in list; the shared library may add its own. */
  category: PresetCategory | (string & {})
  description?: string
  action: Action
  /** Suggested app layer, when the preset only makes sense in one app. */
  app?: string
  keywords?: string
}

const k = (key: string, ...modifiers: Modifier[]): SimpleAction => ({ kind: 'keystroke', key, modifiers })

export const PRESETS: Preset[] = [
  // Media
  { id: 'media-play', name: 'Play or pause', category: 'Media', action: { kind: 'media', command: 'playpause' } },
  { id: 'media-next', name: 'Next track', category: 'Media', action: { kind: 'media', command: 'next' } },
  { id: 'media-prev', name: 'Previous track', category: 'Media', action: { kind: 'media', command: 'previous' } },
  { id: 'vol-up', name: 'Volume up', category: 'Media', action: { kind: 'volume', step: 6 } },
  { id: 'vol-down', name: 'Volume down', category: 'Media', action: { kind: 'volume', step: -6 } },
  { id: 'vol-mute', name: 'Mute or unmute', category: 'Media', action: { kind: 'mute' } },
  { id: 'bright-up', name: 'Brightness up', category: 'Media', action: { kind: 'brightness', step: 1 } },
  { id: 'bright-down', name: 'Brightness down', category: 'Media', action: { kind: 'brightness', step: -1 } },
  { id: 'music-open', name: 'Open Music', category: 'Media', action: { kind: 'open', target: 'Music' } },
  { id: 'spotify-open', name: 'Open Spotify', category: 'Media', action: { kind: 'open', target: 'Spotify' } },
  { id: 'zoom-mute', name: 'Mute in Zoom', category: 'Media', action: k('a', 'command', 'shift'), app: 'us.zoom.xos', keywords: 'meeting call microphone' },
  { id: 'meet-mute', name: 'Mute in Google Meet', category: 'Media', action: k('d', 'command'), app: 'com.google.Chrome', keywords: 'meeting call microphone' },

  // Window
  { id: 'win-left', name: 'Window to left half', category: 'Window', action: { kind: 'window', op: 'left' } },
  { id: 'win-right', name: 'Window to right half', category: 'Window', action: { kind: 'window', op: 'right' } },
  { id: 'win-top', name: 'Window to top half', category: 'Window', action: { kind: 'window', op: 'top' } },
  { id: 'win-bottom', name: 'Window to bottom half', category: 'Window', action: { kind: 'window', op: 'bottom' } },
  { id: 'win-max', name: 'Fill the screen', category: 'Window', action: { kind: 'window', op: 'maximize' } },
  { id: 'win-center', name: 'Center window', category: 'Window', action: { kind: 'window', op: 'center' } },
  { id: 'win-display', name: 'Move to next display', category: 'Window', action: { kind: 'window', op: 'next-display' } },
  { id: 'win-min', name: 'Minimize window', category: 'Window', action: { kind: 'window', op: 'minimize' } },
  { id: 'win-full', name: 'Toggle full screen', category: 'Window', action: { kind: 'window', op: 'fullscreen' } },
  { id: 'win-close', name: 'Close window', category: 'Window', action: k('w', 'command') },

  // System
  { id: 'sys-lock', name: 'Lock screen', category: 'System', action: { kind: 'system', op: 'lock' } },
  { id: 'sys-sleep', name: 'Sleep display', category: 'System', action: { kind: 'system', op: 'sleep-display' } },
  { id: 'sys-shot', name: 'Screenshot', category: 'System', action: { kind: 'system', op: 'screenshot' } },
  { id: 'sys-shot-area', name: 'Screenshot of an area', category: 'System', action: { kind: 'system', op: 'screenshot-area' } },
  { id: 'sys-dnd', name: 'Toggle Do Not Disturb', category: 'System', action: { kind: 'system', op: 'dnd-toggle' }, keywords: 'focus' },
  { id: 'sys-mc', name: 'Mission Control', category: 'System', action: { kind: 'system', op: 'mission-control' } },
  { id: 'sys-lp', name: 'Launchpad', category: 'System', action: { kind: 'system', op: 'launchpad' } },
  { id: 'sys-desktop', name: 'Show desktop', category: 'System', action: { kind: 'system', op: 'show-desktop' } },
  { id: 'sys-spotlight', name: 'Open Spotlight', category: 'System', action: k('space', 'command'), keywords: 'search' },
  { id: 'sys-emoji', name: 'Character viewer', category: 'System', action: k('space', 'control', 'command') },

  // Apps
  { id: 'app-next', name: 'Switch to next app', category: 'Apps', action: { kind: 'app', op: 'switch-next' } },
  { id: 'app-prev', name: 'Switch to previous app', category: 'Apps', action: { kind: 'app', op: 'switch-previous' } },
  { id: 'app-hide', name: 'Hide frontmost app', category: 'Apps', action: { kind: 'app', op: 'hide' } },
  { id: 'app-quit', name: 'Quit frontmost app', category: 'Apps', action: { kind: 'app', op: 'quit' } },
  { id: 'app-finder', name: 'Open Finder', category: 'Apps', action: { kind: 'open', target: 'Finder' } },
  { id: 'app-mail', name: 'Open Mail', category: 'Apps', action: { kind: 'open', target: 'Mail' } },
  { id: 'app-calendar', name: 'Open Calendar', category: 'Apps', action: { kind: 'open', target: 'Calendar' } },
  { id: 'app-notes', name: 'Open Notes', category: 'Apps', action: { kind: 'open', target: 'Notes' } },
  { id: 'app-messages', name: 'Open Messages', category: 'Apps', action: { kind: 'open', target: 'Messages' } },
  { id: 'app-terminal', name: 'Open Terminal', category: 'Apps', action: { kind: 'open', target: 'Terminal' } },

  // Excel and Sheets
  { id: 'xl-sum', name: 'AutoSum', category: 'Excel and Sheets', action: k('t', 'command', 'shift'), app: 'com.microsoft.Excel' },
  { id: 'xl-fill-down', name: 'Fill down', category: 'Excel and Sheets', action: k('d', 'command'), app: 'com.microsoft.Excel' },
  { id: 'xl-fill-right', name: 'Fill right', category: 'Excel and Sheets', action: k('r', 'command'), app: 'com.microsoft.Excel' },
  { id: 'xl-paste-values', name: 'Paste values only', category: 'Excel and Sheets', action: k('v', 'command', 'shift'), app: 'com.microsoft.Excel' },
  { id: 'xl-insert-row', name: 'Insert row', category: 'Excel and Sheets', action: k('=', 'control', 'shift'), app: 'com.microsoft.Excel' },
  { id: 'xl-delete-row', name: 'Delete row', category: 'Excel and Sheets', action: k('-', 'control'), app: 'com.microsoft.Excel' },
  { id: 'xl-anchor', name: 'Toggle absolute reference', category: 'Excel and Sheets', action: k('t', 'command'), app: 'com.microsoft.Excel', keywords: 'f4 dollar' },
  { id: 'xl-next-sheet', name: 'Next sheet', category: 'Excel and Sheets', action: k('pagedown', 'fn', 'control'), app: 'com.microsoft.Excel' },
  { id: 'xl-prev-sheet', name: 'Previous sheet', category: 'Excel and Sheets', action: k('pageup', 'fn', 'control'), app: 'com.microsoft.Excel' },
  { id: 'xl-filter', name: 'Toggle filter', category: 'Excel and Sheets', action: k('f', 'command', 'shift'), app: 'com.microsoft.Excel' },
  { id: 'sh-paste-values', name: 'Sheets: paste values only', category: 'Excel and Sheets', action: k('v', 'command', 'shift'), app: 'com.google.Chrome' },

  // Browser
  { id: 'br-new-tab', name: 'New tab', category: 'Browser', action: k('t', 'command') },
  { id: 'br-close-tab', name: 'Close tab', category: 'Browser', action: k('w', 'command') },
  { id: 'br-reopen', name: 'Reopen closed tab', category: 'Browser', action: k('t', 'command', 'shift') },
  { id: 'br-next-tab', name: 'Next tab', category: 'Browser', action: k('tab', 'control') },
  { id: 'br-prev-tab', name: 'Previous tab', category: 'Browser', action: k('tab', 'control', 'shift') },
  { id: 'br-back', name: 'Back', category: 'Browser', action: k('[', 'command') },
  { id: 'br-forward', name: 'Forward', category: 'Browser', action: k(']', 'command') },
  { id: 'br-reload', name: 'Reload page', category: 'Browser', action: k('r', 'command') },
  { id: 'br-address', name: 'Focus address bar', category: 'Browser', action: k('l', 'command') },

  // Dev
  { id: 'dev-palette', name: 'VS Code command palette', category: 'Dev', action: k('p', 'command', 'shift'), app: 'com.microsoft.VSCode' },
  { id: 'dev-terminal', name: 'VS Code toggle terminal', category: 'Dev', action: k('`', 'control'), app: 'com.microsoft.VSCode' },
  { id: 'dev-comment', name: 'Toggle line comment', category: 'Dev', action: k('/', 'command') },
  { id: 'dev-run', name: 'Xcode run', category: 'Dev', action: k('r', 'command'), app: 'com.apple.dt.Xcode' },
  { id: 'dev-build', name: 'Xcode build', category: 'Dev', action: k('b', 'command'), app: 'com.apple.dt.Xcode' },
  { id: 'dev-git-status', name: 'Copy git status of home folder', category: 'Dev', action: { kind: 'shell', command: 'cd ~ && git status --short | pbcopy' } },
  { id: 'dev-clear', name: 'Clear terminal', category: 'Dev', action: k('k', 'command'), app: 'com.apple.Terminal' },
  { id: 'dev-save-all', name: 'Save all', category: 'Dev', action: k('s', 'command', 'option') },

  // Writing
  { id: 'wr-undo', name: 'Undo', category: 'Writing', action: k('z', 'command') },
  { id: 'wr-redo', name: 'Redo', category: 'Writing', action: k('z', 'command', 'shift') },
  { id: 'wr-copy', name: 'Copy', category: 'Writing', action: k('c', 'command') },
  { id: 'wr-paste', name: 'Paste', category: 'Writing', action: k('v', 'command') },
  { id: 'wr-paste-plain', name: 'Paste without formatting', category: 'Writing', action: k('v', 'command', 'option', 'shift') },
  { id: 'wr-bold', name: 'Bold', category: 'Writing', action: k('b', 'command') },
  { id: 'wr-italic', name: 'Italic', category: 'Writing', action: k('i', 'command') },
  { id: 'wr-dictate', name: 'Start dictation', category: 'Writing', action: k('d', 'fn') },
  { id: 'wr-date', name: 'Type today’s date', category: 'Writing', action: { kind: 'shell', command: 'date +%F | tr -d "\\n" | pbcopy' }, keywords: 'timestamp' },
  { id: 'wr-signoff', name: 'Type a sign-off', category: 'Writing', action: { kind: 'text', text: 'Thanks,\n' } },
  {
    id: 'wr-select-line',
    name: 'Select current line',
    category: 'Writing',
    action: {
      kind: 'macro',
      steps: [
        { kind: 'keystroke', key: 'left', modifiers: ['command'] },
        { kind: 'keystroke', key: 'right', modifiers: ['command', 'shift'], delayMs: 40 }
      ]
    }
  }
]
