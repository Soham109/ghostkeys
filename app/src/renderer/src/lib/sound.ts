import { client } from './client'
import { useStore } from './store'

// A felt thump when a tap lands: a short low sine with a fast decay and a breath of noise, about -22 dB.
// Off by default; Settings > Feedback > Tap sound. Synthesized, so there is no audio file.
let ctx: AudioContext | null = null

function thump(strength = 0.6): void {
  ctx ??= new AudioContext()
  const t = ctx.currentTime
  const pitch = 118 * (1 + (Math.random() - 0.5) * 0.06)
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(pitch * 1.6, t)
  osc.frequency.exponentialRampToValueAtTime(pitch, t + 0.03)
  const gain = ctx.createGain()
  const peak = 0.06 + Math.min(1, Math.max(0, strength)) * 0.04
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t)
  osc.stop(t + 0.12)
  // a tiny click of filtered noise for the "felt" edge
  const len = Math.floor(ctx.sampleRate * 0.012)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
  const noise = ctx.createBufferSource()
  noise.buffer = buf
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1800
  const ng = ctx.createGain()
  ng.gain.value = 0.015
  noise.connect(lp).connect(ng).connect(ctx.destination)
  noise.start(t)
}

export function wireTapSound(): void {
  client.on('tap', (m) => {
    if (useStore.getState().info?.prefs.tapSound) thump(m.strength)
  })
}

export function previewTapSound(): void {
  thump(0.6)
}
