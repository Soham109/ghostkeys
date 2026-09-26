import { err } from './format.js'

/** Prints a one-line error and marks the process to exit non-zero, without throwing or exiting immediately. */
export function fail(message: string): void {
  console.error(err(message))
  process.exitCode = 1
}
