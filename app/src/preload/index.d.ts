import type { GhostkeysBridge } from '../shared/ipc'

declare global {
  interface Window {
    gk: GhostkeysBridge
    __gk?: {
      ready(): Promise<void>
      shot(name: string): Promise<void>
    }
  }
}

export {}
