export interface KnownApp {
  id: string
  name: string
}

/** Common apps for the app-layer picker. Any bundle id can also be typed in. */
export const COMMON_APPS: KnownApp[] = [
  { id: 'com.apple.Safari', name: 'Safari' },
  { id: 'com.google.Chrome', name: 'Google Chrome' },
  { id: 'company.thebrowser.Browser', name: 'Arc' },
  { id: 'org.mozilla.firefox', name: 'Firefox' },
  { id: 'com.microsoft.Excel', name: 'Microsoft Excel' },
  { id: 'com.microsoft.Word', name: 'Microsoft Word' },
  { id: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint' },
  { id: 'com.apple.iWork.Numbers', name: 'Numbers' },
  { id: 'com.apple.iWork.Pages', name: 'Pages' },
  { id: 'com.apple.iWork.Keynote', name: 'Keynote' },
  { id: 'com.microsoft.VSCode', name: 'Visual Studio Code' },
  { id: 'com.todesktop.230313mzl4w4u92', name: 'Cursor' },
  { id: 'com.apple.dt.Xcode', name: 'Xcode' },
  { id: 'com.apple.Terminal', name: 'Terminal' },
  { id: 'com.googlecode.iterm2', name: 'iTerm' },
  { id: 'com.figma.Desktop', name: 'Figma' },
  { id: 'com.tinyspeck.slackmacgap', name: 'Slack' },
  { id: 'us.zoom.xos', name: 'Zoom' },
  { id: 'com.spotify.client', name: 'Spotify' },
  { id: 'com.apple.Music', name: 'Music' },
  { id: 'com.apple.finder', name: 'Finder' },
  { id: 'com.apple.mail', name: 'Mail' },
  { id: 'com.apple.Notes', name: 'Notes' },
  { id: 'notion.id', name: 'Notion' },
  { id: 'md.obsidian', name: 'Obsidian' },
  { id: 'com.linear', name: 'Linear' },
  { id: 'com.apple.Preview', name: 'Preview' },
  { id: 'com.adobe.Photoshop', name: 'Photoshop' }
]

export function appName(id: string): string {
  if (id === '*') return 'Everywhere'
  return COMMON_APPS.find((a) => a.id === id)?.name ?? id
}
