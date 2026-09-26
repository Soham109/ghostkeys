/** A minimal typed pub-sub emitter. No Node `EventEmitter` dependency, so it works in a browser too. */
export type Listener<T> = (payload: T) => void
export type Unsubscribe = () => void

export class TypedEmitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => this.off(event, listener)
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener)
  }

  removeAllListeners<K extends keyof Events>(event?: K): void {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return
    // Copy first: a listener that unsubscribes itself (or others) mid-emit must not skip anyone.
    for (const listener of [...set]) {
      listener(payload)
    }
  }
}
