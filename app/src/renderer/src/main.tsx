import * as React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'
import 'uplot/dist/uPlot.min.css'
import { App } from './App'
import { client } from './lib/client'
import { useStore, wireClient, type Route, ROUTES } from './lib/store'
import { installShots } from './lib/shots'

async function boot(): Promise<void> {
  wireClient()
  const info = await window.gk.info()
  useStore.setState({ info, daemon: info.daemon, license: info.license })
  window.gk.onDaemonState((daemon) => {
    useStore.setState({ daemon })
    client.retryNow()
  })
  window.gk.onNavigate((route) => {
    if ((ROUTES as string[]).includes(route)) useStore.getState().navigate(route as Route)
  })
  if (info.screenshot) {
    document.documentElement.dataset.screenshot = '1'
    installShots()
  }
  client.start(info.conn, info.snapshot)
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
