import type { GhostkeysBridge } from '../shared/ipc'

declare global {
  interface Window {
    gk: GhostkeysBridge
    __gk?: {
      ready(): Promise<void>
      summary(): Record<string, unknown>
      shot(name: string): Promise<void>
    }
  }
}

export {}
