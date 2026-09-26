import readline from 'node:readline/promises'

/**
 * Asks a yes/no question. When stdin is not a TTY (piped, or a test), there is no one to answer,
 * so this resolves to `false` immediately rather than hanging forever.
 */
export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${message} [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** Waits for the user to press enter. A no-op when stdin is not a TTY, so scripts never block. */
export async function pressEnter(message: string): Promise<void> {
  if (!process.stdin.isTTY) return
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    await rl.question(`${message} `)
  } finally {
    rl.close()
  }
}
