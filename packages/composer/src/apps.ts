/** Known macOS apps: spoken names, bundle ids and integration keys. */
import type { INTEGRATION_APPS } from './schema.js'

export interface KnownApp {
  name: string
  bundleId: string
  aliases: string[]
  integration?: (typeof INTEGRATION_APPS)[number]
}

export const KNOWN_APPS: KnownApp[] = [
  { name: 'Microsoft Excel', bundleId: 'com.microsoft.Excel', aliases: ['excel', 'microsoft excel'], integration: 'excel' },
  { name: 'Microsoft Word', bundleId: 'com.microsoft.Word', aliases: ['word', 'microsoft word'] },
  { name: 'Microsoft PowerPoint', bundleId: 'com.microsoft.Powerpoint', aliases: ['powerpoint', 'microsoft powerpoint'], integration: 'powerpoint' },
  { name: 'Google Chrome', bundleId: 'com.google.Chrome', aliases: ['chrome', 'google chrome'], integration: 'chrome' },
  { name: 'Safari', bundleId: 'com.apple.Safari', aliases: ['safari'], integration: 'safari' },
  { name: 'Arc', bundleId: 'company.thebrowser.Browser', aliases: ['arc', 'arc browser'], integration: 'arc' },
  { name: 'Firefox', bundleId: 'org.mozilla.firefox', aliases: ['firefox'] },
  { name: 'Music', bundleId: 'com.apple.Music', aliases: ['apple music', 'music app'], integration: 'music' },
  { name: 'Spotify', bundleId: 'com.spotify.client', aliases: ['spotify'], integration: 'spotify' },
  { name: 'Finder', bundleId: 'com.apple.finder', aliases: ['finder'], integration: 'finder' },
  { name: 'Keynote', bundleId: 'com.apple.iWork.Keynote', aliases: ['keynote'], integration: 'keynote' },
  { name: 'Pages', bundleId: 'com.apple.iWork.Pages', aliases: ['pages'] },
  { name: 'Numbers', bundleId: 'com.apple.iWork.Numbers', aliases: ['numbers'] },
  { name: 'Zoom', bundleId: 'us.zoom.xos', aliases: ['zoom'], integration: 'zoom' },
  { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', aliases: ['slack'] },
  { name: 'Discord', bundleId: 'com.hnc.Discord', aliases: ['discord'] },
  { name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', aliases: ['vs code', 'vscode', 'visual studio code'] },
  { name: 'Xcode', bundleId: 'com.apple.dt.Xcode', aliases: ['xcode'] },
  { name: 'Terminal', bundleId: 'com.apple.Terminal', aliases: ['terminal'] },
  { name: 'iTerm', bundleId: 'com.googlecode.iterm2', aliases: ['iterm', 'iterm2'] },
  { name: 'Notes', bundleId: 'com.apple.Notes', aliases: ['notes', 'apple notes'] },
  { name: 'Mail', bundleId: 'com.apple.mail', aliases: ['mail', 'apple mail'] },
  { name: 'Messages', bundleId: 'com.apple.MobileSMS', aliases: ['messages', 'imessage'] },
  { name: 'Calendar', bundleId: 'com.apple.iCal', aliases: ['calendar'] },
  { name: 'Figma', bundleId: 'com.figma.Desktop', aliases: ['figma'] },
  { name: 'Notion', bundleId: 'notion.id', aliases: ['notion'] },
  { name: 'Photoshop', bundleId: 'com.adobe.Photoshop', aliases: ['photoshop'] },
  { name: 'Preview', bundleId: 'com.apple.Preview', aliases: ['preview'] }
]

export function findAppByName(text: string): KnownApp | undefined {
  const t = text.toLowerCase().trim()
  // Longest alias first so "apple music" beats "music".
  let best: KnownApp | undefined
  let bestLen = 0
  for (const app of KNOWN_APPS) {
    for (const alias of app.aliases) {
      if (t === alias && alias.length > bestLen) {
        best = app
        bestLen = alias.length
      }
    }
  }
  return best
}

export function findAppByBundle(bundleId: string): KnownApp | undefined {
  const b = bundleId.toLowerCase()
  return KNOWN_APPS.find((a) => a.bundleId.toLowerCase() === b)
}

export function appDisplayName(bundleId: string): string {
  if (bundleId === '*') return 'every app'
  return findAppByBundle(bundleId)?.name ?? bundleId
}

export function bundleForIntegration(app: (typeof INTEGRATION_APPS)[number]): string | undefined {
  return KNOWN_APPS.find((a) => a.integration === app)?.bundleId
}
