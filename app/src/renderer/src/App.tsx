import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Toaster } from 'sonner'
import { useStore, isDirty, ROUTES } from './lib/store'
import { TooltipProvider } from './components/ui/controls'
import { Sidebar } from './components/Sidebar'
import { SaveBar } from './components/SaveBar'
import { ServiceOffline, ReconnectBanner } from './components/ServiceOffline'
import { CommandPalette } from './components/CommandPalette'
import { LiveScreen } from './screens/Live'
import { ZonesScreen } from './screens/Zones'
import { BindingsScreen } from './screens/Bindings'
import { CalibrationScreen } from './screens/Calibration'
import { SensorsScreen } from './screens/Sensors'
import { SettingsScreen } from './screens/Settings'
import { Onboarding } from './screens/Onboarding'

function useTheme(): void {
  const mode = useStore((s) => s.info?.prefs.theme ?? 'system')
  const override = useStore((s) => s.themeOverride)
  React.useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const resolved = override ?? (mode === 'system' ? (mq.matches ? 'dark' : 'light') : mode)
      document.documentElement.dataset.theme = resolved
      useStore.setState({ resolvedTheme: resolved })
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [mode, override])
}

function useGlobalKeys(): void {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      const s = useStore.getState()
      if (e.key === 'k') {
        e.preventDefault()
        useStore.setState({ paletteOpen: !s.paletteOpen })
      } else if (e.key === 's') {
        e.preventDefault()
        if (isDirty(s)) void s.saveDraft()
      } else if (/^[1-6]$/.test(e.key) && !s.onboarding) {
        e.preventDefault()
        s.navigate(ROUTES[Number(e.key) - 1]!)
      } else if (e.key === ',' && !s.onboarding) {
        e.preventDefault()
        s.navigate('settings')
      } else if (e.key === 'n' && !s.onboarding) {
        e.preventDefault()
        s.navigate('bindings')
        useStore.setState({ editingBinding: 'new' })
      } else if (e.key === 'f' && s.route === 'bindings') {
        e.preventDefault()
        window.dispatchEvent(new Event('gk:focus-filter'))
      }
    }
    window.addEventListener('keydown', onKey)
    // The native menu bar owns these shortcuts when it exists; its commands arrive here.
    const offMenu = window.gk.onMenu((cmd) => {
      const s = useStore.getState()
      if (cmd.startsWith('go:')) {
        const r = cmd.slice(3) as (typeof ROUTES)[number]
        if (ROUTES.includes(r)) useStore.setState({ onboarding: false, route: r, paletteOpen: false })
      } else if (cmd === 'new-binding') {
        s.navigate('bindings')
        useStore.setState({ editingBinding: 'new' })
      } else if (cmd === 'library') {
        s.navigate('bindings')
        useStore.setState({ presetsOpen: true })
      } else if (cmd === 'save') {
        if (isDirty(s)) void s.saveDraft()
      } else if (cmd === 'palette') useStore.setState({ paletteOpen: !s.paletteOpen })
      else if (cmd === 'tour') useStore.setState({ onboarding: true, onboardingStep: 0 })
      else if (cmd === 'pause-toggle') s.setPaused(!s.status?.paused)
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      offMenu()
    }
  }, [])
}

const SCREENS = {
  live: LiveScreen,
  zones: ZonesScreen,
  bindings: BindingsScreen,
  calibration: CalibrationScreen,
  sensors: SensorsScreen,
  settings: SettingsScreen
} as const

function useWindowFocus(): void {
  React.useEffect(() => {
    const on = (): void => useStore.setState({ windowFocused: true })
    const off = (): void => useStore.setState({ windowFocused: false })
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])
}

/** VoiceOver hears what the HUD shows: "Left grille, volume down". */
function Announcer(): React.JSX.Element {
  const feed = useStore((s) => s.feed)
  const config = useStore((s) => s.config)
  const top = feed[0]
  const zone = top?.gesture.zone ? config?.zones.find((z) => z.id === top.gesture.zone)?.name : null
  const text = top?.action ? `${zone ?? ''}${zone ? ', ' : ''}${top.action.label}` : ''
  return (
    <div className="sr-only" aria-live="polite">
      {text}
    </div>
  )
}

export function App(): React.JSX.Element {
  useTheme()
  useGlobalKeys()
  useWindowFocus()
  const route = useStore((s) => s.route)
  const onboarding = useStore((s) => s.onboarding)
  const conn = useStore((s) => s.conn)
  const everConnected = useStore((s) => s.everConnected)
  const forceOffline = useStore((s) => s.forceOffline)
  const theme = useStore((s) => s.resolvedTheme)
  const [grace, setGrace] = React.useState(true)
  React.useEffect(() => {
    const t = setTimeout(() => setGrace(false), 1400)
    return () => clearTimeout(t)
  }, [])

  const offline = forceOffline || (!everConnected && conn !== 'open' && !grace)
  const Screen = SCREENS[route]

  return (
    <TooltipProvider>
      <div className="flex h-full">
        {onboarding && !offline ? (
          <Onboarding />
        ) : (
          <>
            <Sidebar offline={offline} />
            <main className="relative flex min-w-0 flex-1 flex-col bg-bg shadow-[-1px_0_0_var(--hairline)]">
              {offline ? (
                <ServiceOffline />
              ) : (
                <>
                  <ReconnectBanner />
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={route}
                      className="flex min-h-0 flex-1 flex-col"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
                    >
                      <Screen />
                    </motion.div>
                  </AnimatePresence>
                  <SaveBar />
                </>
              )}
            </main>
          </>
        )}
      </div>
      <CommandPalette />
      <Announcer />
      <Toaster
        theme={theme}
        position="bottom-right"
        offset={20}
        toastOptions={{
          unstyled: true,
          classNames: {
            toast: 'material flex w-[320px] items-start gap-2.5 rounded-[8px] px-3.5 py-3 text-[13px] text-ink',
            title: 'font-medium',
            description: 'text-[12px] text-ink-2 mt-0.5',
            icon: 'mt-px text-ink-2 [&_svg]:size-4'
          }
        }}
      />
    </TooltipProvider>
  )
}
