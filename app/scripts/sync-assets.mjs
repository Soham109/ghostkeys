// Copies the brand assets (repo assets/icon, assets/tray) into resources/ when they exist.
// Falls back to the icons rasterized by gen-icons.mjs from docs/design/logo.svg.
import { copyFileSync, existsSync } from 'node:fs'

const repo = new URL('../../', import.meta.url).pathname
const res = new URL('../resources/', import.meta.url).pathname
const pairs = [
  ['assets/icon/AppIcon.icns', 'icon.icns'],
  ['assets/icon/png/icon-1024.png', 'icon.png'],
  ['assets/tray/GhostkeysTemplate.png', 'trayTemplate.png'],
  ['assets/tray/GhostkeysTemplate@2x.png', 'trayTemplate@2x.png'],
  ['assets/tray/GhostkeysPausedTemplate.png', 'trayPausedTemplate.png'],
  ['assets/tray/GhostkeysPausedTemplate@2x.png', 'trayPausedTemplate@2x.png']
]
let n = 0
for (const [from, to] of pairs) {
  if (existsSync(repo + from)) {
    copyFileSync(repo + from, res + to)
    n++
  }
}
console.log(`[assets] ${n} brand asset${n === 1 ? '' : 's'} copied into resources/`)
