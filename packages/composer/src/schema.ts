/**
 * Zod mirror of docs/PROTOCOL.md (config, zones, gestures, bindings, actions).
 * Anything the composer returns has passed `BindingSchema`.
 */
import { z } from 'zod'

export const MODIFIERS = ['shift', 'control', 'option', 'command', 'fn'] as const
export const GESTURES = [
  'tap',
  'double',
  'triple',
  'sequence',
  'rhythm',
  'lid_nudge',
  'cover',
  'cover_hold',
  'tilt_left',
  'tilt_right'
] as const
export const SURFACES = ['base', 'lid', 'edge-left', 'edge-right', 'front'] as const
export const DEFAULT_ZONE_IDS = [
  'left-palm',
  'right-palm',
  'left-grille',
  'right-grille',
  'top-strip',
  'left-edge',
  'right-edge',
  'lid'
] as const

/** Gestures that are detected per zone (taps). The rest are whole-device gestures. */
export const ZONE_GESTURES = ['tap', 'double', 'triple', 'sequence', 'rhythm'] as const
export const DEVICE_GESTURES = ['lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right'] as const

export const MEDIA_COMMANDS = ['playpause', 'next', 'previous'] as const
export const WINDOW_OPS = [
  'left',
  'right',
  'top',
  'bottom',
  'maximize',
  'center',
  'next-display',
  'minimize',
  'fullscreen'
] as const
export const APP_OPS = ['hide', 'quit', 'switch-next', 'switch-previous'] as const
export const SYSTEM_OPS = [
  'lock',
  'sleep-display',
  'screenshot',
  'screenshot-area',
  'dnd-toggle',
  'mission-control',
  'launchpad',
  'show-desktop'
] as const
export const INTEGRATION_APPS = [
  'excel',
  'chrome',
  'safari',
  'arc',
  'music',
  'spotify',
  'finder',
  'powerpoint',
  'keynote',
  'zoom'
] as const
/** Integration commands documented in PROTOCOL.md. Others are allowed with a warning. */
export const KNOWN_INTEGRATION_COMMANDS: Partial<Record<(typeof INTEGRATION_APPS)[number], readonly string[]>> = {
  excel: ['wrap-iferror', 'toggle-absolute', 'cycle-number-format', 'insert-xlookup']
}

export const MACRO_MAX_STEPS = 50
export const MACRO_MAX_TOTAL_MS = 30_000

export const ModifierSchema = z.enum(MODIFIERS)
export const GestureSchema = z.enum(GESTURES)
export const SurfaceSchema = z.enum(SURFACES)

export const ZoneSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'zone id must be kebab-case'),
  name: z.string().min(1),
  surface: SurfaceSchema,
  rect: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1)
  }),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/)
})

const nonEmpty = z.string().trim().min(1)
const step = z
  .number()
  .int()
  .min(-100)
  .max(100)
  .refine((n) => n !== 0, 'step must not be 0')
const modifierList = z.array(ModifierSchema).refine((m) => new Set(m).size === m.length, 'duplicate modifier')

const argValue = z.union([z.string(), z.number(), z.boolean()])

/** Leaf action shapes, keyed by kind. `withDelay` adds the optional macro-step `delayMs`. */
function leafActions<T extends z.ZodRawShape>(extra: T) {
  return [
    z.strictObject({ kind: z.literal('keystroke'), key: nonEmpty, modifiers: modifierList, ...extra }),
    z.strictObject({ kind: z.literal('volume'), step, ...extra }),
    z.strictObject({ kind: z.literal('mute'), ...extra }),
    z.strictObject({ kind: z.literal('media'), command: z.enum(MEDIA_COMMANDS), ...extra }),
    z.strictObject({ kind: z.literal('brightness'), step, ...extra }),
    z.strictObject({ kind: z.literal('open'), target: nonEmpty, ...extra }),
    z.strictObject({ kind: z.literal('shell'), command: nonEmpty, ...extra }),
    z.strictObject({ kind: z.literal('applescript'), source: nonEmpty, ...extra }),
    z.strictObject({ kind: z.literal('shortcut'), name: nonEmpty, ...extra }),
    z.strictObject({ kind: z.literal('text'), text: z.string().min(1), ...extra }),
    z.strictObject({ kind: z.literal('clipboard'), text: z.string(), ...extra }),
    z.strictObject({ kind: z.literal('window'), op: z.enum(WINDOW_OPS), ...extra }),
    z.strictObject({ kind: z.literal('app'), op: z.enum(APP_OPS), ...extra }),
    z.strictObject({
      kind: z.literal('integration'),
      app: z.enum(INTEGRATION_APPS),
      command: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'integration command must be kebab-case'),
      args: z.record(z.string(), argValue).optional(),
      ...extra
    }),
    z.strictObject({ kind: z.literal('system'), op: z.enum(SYSTEM_OPS), ...extra })
  ] as const
}

export const LeafActionSchema = z.discriminatedUnion('kind', leafActions({}))
export const MacroStepSchema = z.discriminatedUnion(
  'kind',
  leafActions({ delayMs: z.number().int().min(0).max(MACRO_MAX_TOTAL_MS).optional() })
)

export const MacroActionSchema = z
  .strictObject({
    kind: z.literal('macro'),
    steps: z.array(MacroStepSchema).min(1).max(MACRO_MAX_STEPS)
  })
  .refine(
    (m) => m.steps.reduce((sum, s) => sum + (s.delayMs ?? 0), 0) <= MACRO_MAX_TOTAL_MS,
    `macro delays must add up to at most ${MACRO_MAX_TOTAL_MS} ms`
  )

export const ActionSchema = z.union([LeafActionSchema, MacroActionSchema])

export const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export const BindingSchema = z
  .strictObject({
    id: nonEmpty,
    enabled: z.boolean(),
    gesture: GestureSchema,
    zone: z.string().nullable(),
    zones: z.array(z.string()).nullable(),
    modifiers: modifierList,
    app: z.union([z.literal('*'), z.string().regex(BUNDLE_ID_RE, 'app must be "*" or a bundle id')]),
    action: ActionSchema,
    label: nonEmpty
  })
  .superRefine((b, ctx) => {
    const zoneGesture = (ZONE_GESTURES as readonly string[]).includes(b.gesture)
    if (b.gesture === 'sequence') {
      if (!b.zones || b.zones.length !== 2) {
        ctx.addIssue({ code: 'custom', path: ['zones'], message: 'sequence needs exactly two zones' })
      } else {
        if (b.zones[0] === b.zones[1])
          ctx.addIssue({ code: 'custom', path: ['zones'], message: 'sequence zones must differ' })
        if (b.zone !== b.zones[0])
          ctx.addIssue({ code: 'custom', path: ['zone'], message: 'zone must equal zones[0] for a sequence' })
      }
    } else if (zoneGesture) {
      if (!b.zone) ctx.addIssue({ code: 'custom', path: ['zone'], message: `${b.gesture} needs a zone` })
      if (b.zones && (b.zones.length !== 1 || b.zones[0] !== b.zone))
        ctx.addIssue({ code: 'custom', path: ['zones'], message: 'zones must be null or [zone]' })
    } else if (b.zone !== null) {
      ctx.addIssue({ code: 'custom', path: ['zone'], message: `${b.gesture} is a whole-device gesture; zone must be null` })
    }
  })

export const SettingsSchema = z.object({
  sensitivity: z.number(),
  typingGateMs: z.number(),
  doubleWindowMs: z.number(),
  minConfidence: z.number(),
  hud: z.boolean(),
  haptics: z.boolean()
})

export const ConfigSchema = z.object({
  version: z.literal(1),
  zones: z.array(ZoneSchema),
  bindings: z.array(BindingSchema),
  settings: SettingsSchema.partial().optional()
})

export type Modifier = z.infer<typeof ModifierSchema>
export type Gesture = z.infer<typeof GestureSchema>
export type Zone = z.infer<typeof ZoneSchema>
export type LeafAction = z.infer<typeof LeafActionSchema>
export type MacroStep = z.infer<typeof MacroStepSchema>
export type MacroAction = z.infer<typeof MacroActionSchema>
export type Action = z.infer<typeof ActionSchema>
export type Binding = z.infer<typeof BindingSchema>
export type Config = z.infer<typeof ConfigSchema>

/** Format zod issues as short "path: message" lines for humans and for the model retry. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
}
