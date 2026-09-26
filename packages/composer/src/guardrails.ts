/**
 * Safety guardrails enforced in code. The model prompt repeats these rules, but nothing
 * the model (or the offline parser) produces reaches the caller without passing here.
 */
import type { Action, Binding, Gesture, LeafAction } from './schema.js'

export interface Violation {
  /** Short machine code, e.g. "sudo", "rm-rf", "pipe-to-shell", "network-write". */
  code: string
  message: string
  /** Where the offending text came from, e.g. "shell", "macro step 2 (applescript)". */
  where: string
}

export interface DestructiveReason {
  where: string
  message: string
}

const INTERPRETERS = '(?:ba|z|k|c|tc|da|fi)?sh|python[0-9.]*|perl|ruby|node|php|osascript|source|eval'

interface Rule {
  code: string
  message: string
  test: (s: string) => boolean
}

/** Split a shell string into simple command segments on ; && || | & newline. */
function segments(cmd: string): string[] {
  return cmd
    // Quotes, subshells and braces also split, so commands nested in `do shell script "..."`,
    // `sh -c '...'` or `$(...)` are inspected too.
    .split(/\|\||&&|;|\||&|\n|["'`]|\$\(|[(){}]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function tokens(segment: string): string[] {
  return segment.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''))
}

/** Strip a leading `env X=1`, `command`, `builtin`, `nohup`, `exec`, `time` and path prefix. */
function commandName(toks: string[]): { name: string; rest: string[] } {
  let i = 0
  while (i < toks.length) {
    const t = toks[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || ['env', 'command', 'builtin', 'nohup', 'exec', 'time', 'xargs', '\\'].includes(t)) {
      i++
      continue
    }
    break
  }
  const raw = toks[i] ?? ''
  const name = raw.replace(/^\\/, '').split('/').pop() ?? ''
  return { name, rest: toks.slice(i + 1) }
}

function isRecursiveForceRm(segment: string): boolean {
  const { name, rest } = commandName(tokens(segment))
  if (name !== 'rm') return false
  let recursive = false
  let force = false
  const targets: string[] = []
  for (const t of rest) {
    if (t === '--recursive') recursive = true
    else if (t === '--force') force = true
    else if (/^-[A-Za-z]+$/.test(t)) {
      if (/[rR]/.test(t)) recursive = true
      if (/f/.test(t)) force = true
    } else targets.push(t)
  }
  if (recursive && force) return true
  // Recursive delete of the root, home or a whole top-level folder is just as bad without -f.
  return recursive && targets.some((p) => /^(\/|~\/?|\$home\/?|\/\*|~\/\*|\/users\/?[^/]*\/?|\.\.?\/?)$/i.test(p))
}

const NETWORK_WRITE_CURL = /\b(curl)\b[^|;&]*(\s-X\s*(post|put|patch|delete)\b|\s--request\s+(post|put|patch|delete)\b|\s-(d|F|T)\b|\s-[a-z]*[dFT]\s|\s--data(-raw|-binary|-urlencode|-ascii)?\b|\s--form\b|\s--upload-file\b|\s--json\b)/i

const SHELL_RULES: Rule[] = [
  { code: 'sudo', message: 'uses sudo or another privilege escalation', test: (s) => /(^|[^a-z0-9_-])(sudo|doas|su|pkexec)(\s|$)/i.test(s) || /with\s+administrator\s+privileges/i.test(s) },
  { code: 'rm-rf', message: 'recursively force deletes files (rm -rf)', test: (s) => segments(s).some(isRecursiveForceRm) },
  { code: 'find-delete', message: 'deletes files in bulk with find', test: (s) => /\bfind\b[^;&|]*(-delete\b|-exec\s+rm\b)/i.test(s) },
  {
    code: 'pipe-to-shell',
    message: 'pipes downloaded or decoded content into a shell or interpreter (curl | sh)',
    test: (s) =>
      new RegExp(`\\|\\s*(sudo\\s+)?(\\S*/)?(${INTERPRETERS})\\b`, 'i').test(s) ||
      new RegExp(`\\b(${INTERPRETERS})\\s+(-c\\s+)?["']?\\$\\(\\s*(curl|wget)`, 'i').test(s) ||
      new RegExp(`\\b(${INTERPRETERS})\\s+<\\(\\s*(curl|wget)`, 'i').test(s) ||
      /\beval\b/i.test(s)
  },
  {
    code: 'network-write',
    message: 'sends data over the network',
    test: (s) =>
      NETWORK_WRITE_CURL.test(s) ||
      /\bwget\b[^|;&]*--(post-data|post-file|method|body-data|body-file)\b/i.test(s) ||
      /(^|[\s;&|(])(nc|ncat|netcat|telnet|ssh|scp|sftp|ftp|socat|mail|sendmail|mutt)(\s|$)/i.test(s) ||
      /\brsync\b[^;&|]*\s\S*:\S*/i.test(s) ||
      /\bgit\s+push\b/i.test(s) ||
      /\b(npm|pnpm|yarn|cargo|gem|twine)\s+publish\b/i.test(s) ||
      /\bhttps?\s+(post|put|patch|delete)\b/i.test(s) ||
      /\/dev\/(tcp|udp)\//i.test(s)
  },
  {
    code: 'system-tamper',
    message: 'changes system configuration, which Ghostkeys never does',
    test: (s) =>
      /\b(launchctl|pmset|networksetup|systemsetup|csrutil|kextload|kextutil|kmutil|spctl|nvram|tccutil|dscl|fdesetup|softwareupdate|installer)\b/i.test(s) ||
      /\bdefaults\s+(write|delete)\b/i.test(s) ||
      /\bscutil\s+--set\b/i.test(s) ||
      /\bdiskutil\s+(erase|zero|partition|reformat|secureerase|apfs\s+delete)/i.test(s) ||
      /\b(mkfs|newfs)[a-z_.]*\b/i.test(s) ||
      /\bdd\b[^;&|]*\bof=/i.test(s) ||
      /\b(shutdown|reboot|halt)\b/i.test(s) ||
      /\bcrontab\b/i.test(s) ||
      /library\/(launchagents|launchdaemons|startupitems)/i.test(s) ||
      /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/i.test(s) ||
      /\bch(own|mod)\s+-R\b[^;&|]*\s(\/|~)(\s|$)/i.test(s) ||
      />\s*\/dev\/(disk|rdisk)/i.test(s)
  },
  { code: 'secrets', message: 'reads the keychain or credential stores', test: (s) => /\bsecurity\s+(find|dump|export)-/i.test(s) || /\.ssh\/id_|\.aws\/credentials/i.test(s) },
  {
    code: 'obfuscation',
    message: 'hides the real command (a variable used as the command name, or escaped characters)',
    test: (s) =>
      s.split(/\|\||&&|;|\||&|\n/).some((seg) => /^\$/.test(commandName(tokens(seg.trim())).name)) || /\\x[0-9a-f]{2}|\\[0-7]{3}|\$'\\/i.test(s)
  },
  {
    code: 'download-and-run',
    message: 'downloads a file and then runs it',
    test: (s) => /\b(curl|wget)\b/i.test(s) && /(^|[;&|]\s*)(\S*\/)?(ba|z|k)?sh\s+\S|\bsource\s+\S|\bchmod\s+[^;&|]*\+?x\b|(^|[;&|]\s*)\.\s+\S|\bopen\s+\S/i.test(s)
  },
  {
    code: 'inline-code',
    message: 'runs inline script code that deletes files, spawns commands or uses the network',
    test: (s) =>
      /\b(python[0-9.]*|perl|ruby|node|php|osascript\s+-l\s+javascript)\b[^;&|]*\s-(c|e)\b/i.test(s) &&
      /\b(rmtree|remove|unlink|rmdir|system|exec|spawn|popen|subprocess|child_process|urllib|requests|socket|http|fetch)\b/i.test(s)
  },
  { code: 'fork-bomb', message: 'is a fork bomb', test: (s) => /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(s) },
  { code: 'kill-all', message: 'kills every process', test: (s) => /\bkill\s+-9\s+-1\b/.test(s) || /\bkillall\s+-9?\s*-u\b/.test(s) }
]

/** Check one shell-like string (a shell command or a `do shell script` body). */
export function checkShell(command: string, where = 'shell'): Violation[] {
  const s = command.normalize('NFKC')
  // Also check a de-obfuscated copy: quotes and backslashes removed, $IFS read as a space.
  const plain = s.replace(/\$\{?IFS\}?/g, ' ').replace(/["'\\]/g, '')
  const out: Violation[] = []
  for (const rule of SHELL_RULES) {
    if (rule.test(s) || rule.test(plain)) out.push({ code: rule.code, message: `${where} ${rule.message}`, where })
  }
  return out
}

const TYPED_TEXT_CODES = ['sudo', 'rm-rf', 'pipe-to-shell', 'fork-bomb']

function checkLeaf(a: LeafAction, where: string): Violation[] {
  switch (a.kind) {
    case 'shell':
      return checkShell(a.command, where)
    case 'applescript': {
      const v = checkShell(a.source, where)
      return v
    }
    case 'text':
    case 'clipboard':
      // Typing or pasting a dangerous command into a terminal is the same attack with one more step.
      // Only the unambiguous patterns, so ordinary prose ("check your mail") is not blocked.
      return checkShell(a.text, where)
        .filter((v) => TYPED_TEXT_CODES.includes(v.code))
        .filter((v) => v.code !== 'sudo' || /\b(sudo|doas)\b|administrator privileges/i.test(a.text))
        .map((v) => ({ ...v, message: `${v.message} (as typed text)` }))
    case 'open': {
      const t = a.target.trim()
      if (/\.(command|sh|zsh|bash|tool|pkg|mpkg|scpt|terminal)$/i.test(t))
        return [{ code: 'open-script', message: `${where} opens a script or installer (${t}), which would run it`, where }]
      if (/^(file|javascript|data|vbscript):/i.test(t))
        return [{ code: 'open-scheme', message: `${where} opens a ${t.split(':')[0]}: URL, which is not allowed`, where }]
      return []
    }
    default:
      return []
  }
}

function forEachLeaf(action: Action, fn: (a: LeafAction, where: string) => void): void {
  if (action.kind === 'macro') {
    action.steps.forEach((s, i) => {
      const { delayMs: _d, ...leaf } = s
      fn(leaf as LeafAction, `macro step ${i + 1} (${s.kind})`)
    })
  } else fn(action, action.kind)
}

/** All blocking safety violations in an action (recurses into macro steps). */
export function checkAction(action: Action): Violation[] {
  const out: Violation[] = []
  forEachLeaf(action, (a, where) => out.push(...checkLeaf(a, where)))
  return out
}

const DESTRUCTIVE_WORDS = /\b(delete|remove|erase|trash|quit|close|kill|terminate|wipe|clear|discard|destroy|force[- ]?quit|empty)\b/i

function leafDestructive(a: LeafAction, where: string): DestructiveReason | null {
  switch (a.kind) {
    case 'app':
      return a.op === 'quit' ? { where, message: 'quits the frontmost app' } : null
    case 'keystroke': {
      const key = a.key.toLowerCase()
      const mods = new Set(a.modifiers)
      if (mods.has('command') && (key === 'q' || key === 'w'))
        return { where, message: key === 'q' ? 'presses Command Q, which quits the app' : 'presses Command W, which closes a window or tab' }
      if (mods.has('command') && mods.has('option') && (key === 'escape' || key === 'esc'))
        return { where, message: 'opens Force Quit' }
      if (['delete', 'backspace', 'forwarddelete', 'forward-delete', 'del'].includes(key))
        return { where, message: 'presses Delete' }
      return null
    }
    case 'shell':
      if (/(^|[\s;&|])(rm|rmdir|unlink|trash|shred|killall|pkill|kill|srm)(\s|$)/.test(a.command) || /\bosascript\b.*\bquit\b/i.test(a.command) || /\bmv\b[^;&|]*\s(\/dev\/null|~\/\.trash)/i.test(a.command))
        return { where, message: 'runs a shell command that deletes files or stops processes' }
      return null
    case 'applescript':
      return DESTRUCTIVE_WORDS.test(a.source) ? { where, message: 'runs an AppleScript that quits, closes or deletes' } : null
    case 'shortcut':
      return DESTRUCTIVE_WORDS.test(a.name) ? { where, message: `runs the "${a.name}" shortcut, which sounds destructive` } : null
    case 'integration':
      return DESTRUCTIVE_WORDS.test(a.command.replace(/-/g, ' ')) ? { where, message: `runs ${a.app} ${a.command}, which sounds destructive` } : null
    default:
      return null
  }
}

/** Reasons an action is destructive (app quit, window close, delete, ...). Empty when harmless. */
export function destructiveReasons(action: Action): DestructiveReason[] {
  const out: DestructiveReason[] = []
  forEachLeaf(action, (a, where) => {
    const r = leafDestructive(a, where)
    if (r) out.push(r)
  })
  return out
}

/** Gestures that are deliberate enough to bind a destructive action without an extra confirmation step. */
export const DELIBERATE_GESTURES: readonly Gesture[] = ['double', 'triple', 'sequence', 'rhythm', 'cover_hold']

export interface DestructiveEnforcement {
  binding: Binding
  destructive: boolean
  requiresConfirmation: boolean
  adjustments: string[]
  reasons: DestructiveReason[]
}

/**
 * Destructive actions must be deliberate: a single tap is upgraded to a double tap, and every
 * destructive binding is flagged `requiresConfirmation` so the UI confirms before saving it.
 */
export function enforceDestructive(binding: Binding): DestructiveEnforcement {
  const reasons = destructiveReasons(binding.action)
  if (reasons.length === 0) return { binding, destructive: false, requiresConfirmation: false, adjustments: [], reasons }
  const adjustments: string[] = []
  let b = binding
  if (b.gesture === 'tap') {
    b = { ...b, gesture: 'double' }
    adjustments.push('Changed the single tap to a double tap because this action is destructive.')
  } else if (!DELIBERATE_GESTURES.includes(b.gesture)) {
    adjustments.push(`Kept the ${b.gesture.replace('_', ' ')} gesture but the binding needs your confirmation because the action is destructive.`)
  }
  return { binding: b, destructive: true, requiresConfirmation: true, adjustments, reasons }
}
