import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import type { DaemonState } from '@shared/ipc'

const MAX_RESTARTS_PER_MINUTE = 3

/**
 * Starts ghostkeysd as a child process when it is built and not already running, hands it the
 * per-launch session token, and restarts it after a crash (restoring the sensors first).
 */
export class DaemonSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private stopping = false
  private restarts: number[] = []
  state: DaemonState = { kind: 'starting' }

  constructor(
    private readonly appRoot: string,
    private readonly port: number,
    private readonly mock: boolean,
    private readonly token: string
  ) {
    super()
  }

  private set(state: DaemonState): void {
    this.state = state
    this.emit('state', state)
  }

  candidates(): string[] {
    const fromEnv = process.env.GHOSTKEYSD_PATH
    return [
      ...(fromEnv ? [fromEnv] : []),
      resolve(this.appRoot, '../daemon/.build/release/ghostkeysd'),
      resolve(this.appRoot, '../daemon/.build/debug/ghostkeysd'),
      resolve(this.appRoot, '../daemon/.build-app/release/ghostkeysd'),
      resolve(this.appRoot, '../daemon/.build-app/debug/ghostkeysd')
    ]
  }

  async start(): Promise<void> {
    this.stopping = false
    if (this.mock) {
      this.set({ kind: 'mock' })
      return
    }
    if (await portOpen(this.port)) {
      this.set({ kind: 'external' })
      return
    }
    const bin = this.candidates().find((p) => existsSync(p))
    if (!bin) {
      this.set({ kind: 'missing', searched: this.candidates() })
      return
    }
    this.spawn(bin)
  }

  private spawn(bin: string): void {
    // GHOSTKEYSD_ARGS: extra flags for testing, e.g. "--dry-run" so no action really runs.
    const extra = (process.env.GHOSTKEYSD_ARGS ?? '').split(' ').filter(Boolean)
    const child = spawn(bin, ['--port', String(this.port), '--parent-pid', String(process.pid), ...extra], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GHOSTKEYS_TOKEN: this.token }
    })
    this.child = child
    this.set({ kind: 'running', path: bin, pid: child.pid ?? 0 })
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[ghostkeysd] ${d}`))
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[ghostkeysd] ${d}`))
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return
      const crashed = (code !== null && code !== 0) || signal !== null
      if (crashed) this.recover(bin, code, signal)
      else this.set({ kind: 'exited', path: bin, code, signal: signal ?? null })
    })
    child.on('error', (e) => this.set({ kind: 'exited', path: bin, code: null, signal: null, message: e.message }))
  }

  /** After a crash: put the sensor properties back, then restart, at most 3 times a minute. */
  private recover(bin: string, code: number | null, signal: NodeJS.Signals | null): void {
    const r = spawnSync(bin, ['--restore-sensors'], { timeout: 10_000, stdio: 'ignore' })
    if (r.error) console.error('[daemon] --restore-sensors failed:', r.error.message)
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < 60_000)
    if (this.restarts.length >= MAX_RESTARTS_PER_MINUTE) {
      this.set({ kind: 'exited', path: bin, code, signal: signal ?? null, gaveUp: true })
      return
    }
    this.restarts.push(now)
    this.set({ kind: 'exited', path: bin, code, signal: signal ?? null })
    setTimeout(() => {
      if (!this.stopping && !this.child) this.spawn(bin)
    }, 600)
  }

  async restart(): Promise<void> {
    this.stop()
    this.restarts = []
    this.set({ kind: 'starting' })
    await new Promise((r) => setTimeout(r, 300))
    await this.start()
  }

  /** SIGTERM lets the daemon restore the sensor properties it changed. */
  stop(): void {
    this.stopping = true
    const child = this.child
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 2000)
    child.once('exit', () => clearTimeout(timer))
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (open: boolean): void => {
      socket.destroy()
      res(open)
    }
    socket.setTimeout(300, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
