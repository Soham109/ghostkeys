export class GhostkeysError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GhostkeysError'
  }
}

/** Thrown when a request helper (getConfig, pause, testAction, ...) gets no matching reply in time. */
export class GhostkeysTimeoutError extends GhostkeysError {
  constructor(what: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for ${what}`)
    this.name = 'GhostkeysTimeoutError'
  }
}

/** The daemon itself sent `{ type: "error" }` in response to something the client sent. */
export class GhostkeysProtocolError extends GhostkeysError {
  constructor(message: string) {
    super(message)
    this.name = 'GhostkeysProtocolError'
  }
}

/**
 * setConfig() was called with a revision that no longer matches the client's last-known config.
 * The daemon has no server-side notion of config versioning (config_set is last-write-wins), so
 * this is purely a client-side guard: it stops this client from blindly overwriting a config it
 * fetched a while ago with one that has since changed (locally, or from another connected client).
 */
export class ConfigConflictError extends GhostkeysError {
  constructor(
    public readonly expectedRevision: string | undefined,
    public readonly currentRevision: string | undefined
  ) {
    super(
      `config changed since it was last read (expected revision ${expectedRevision ?? '<none>'}, ` +
        `current revision ${currentRevision ?? '<none>'}); call getConfig() again before retrying setConfig()`
    )
    this.name = 'ConfigConflictError'
  }
}

export class CalibrationCancelledError extends GhostkeysError {
  constructor() {
    super('calibration was cancelled')
    this.name = 'CalibrationCancelledError'
  }
}

export class NotConnectedError extends GhostkeysError {
  constructor(message = 'not connected to ghostkeysd') {
    super(message)
    this.name = 'NotConnectedError'
  }
}
