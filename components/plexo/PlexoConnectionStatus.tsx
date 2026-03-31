'use client'

import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type HealthResponse = {
  ok: boolean
  appId: string
  schemaNamespace: string
  plexoConnected: boolean
  plexoUrl: string | null
  timestamp: string
}

type Status = 'loading' | 'connected' | 'disconnected' | 'error'

function statusDot(status: Status) {
  const colors: Record<Status, string> = {
    loading:      'bg-muted-foreground animate-pulse',
    connected:    'bg-green-500',
    disconnected: 'bg-amber-500',
    error:        'bg-red-500',
  }
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${colors[status]}`}
      aria-hidden
    />
  )
}

function statusLabel(status: Status) {
  const labels: Record<Status, string> = {
    loading:      'Checking...',
    connected:    'Connected to Plexo',
    disconnected: 'Not connected',
    error:        'Connection error',
  }
  return labels[status]
}

export function PlexoConnectionStatus() {
  const [status, setStatus] = useState<Status>('loading')
  const [health, setHealth] = useState<HealthResponse | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' })
        if (cancelled) return
        if (!res.ok) {
          setStatus('error')
          return
        }
        const data: HealthResponse = await res.json()
        setHealth(data)
        setStatus(data.plexoConnected ? 'connected' : 'disconnected')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    check()
    const interval = setInterval(check, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted">
          {statusDot(status)}
          <span>[ j ]</span>
          <span>{statusLabel(status)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 text-xs space-y-3">
        <div className="flex items-center gap-2">
          {statusDot(status)}
          <span className="font-medium text-sm">{statusLabel(status)}</span>
        </div>

        {health && (
          <div className="space-y-1.5 text-muted-foreground">
            <div className="flex justify-between">
              <span>App</span>
              <span className="font-mono text-foreground">{health.appId}</span>
            </div>
            <div className="flex justify-between">
              <span>Schema</span>
              <span className="font-mono text-foreground">{health.schemaNamespace}</span>
            </div>
            {health.plexoUrl && (
              <div className="flex justify-between">
                <span>Core</span>
                <span className="font-mono text-foreground truncate max-w-[140px]">
                  {health.plexoUrl.replace(/^https?:\/\//, '')}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Checked</span>
              <span className="text-foreground">
                {new Date(health.timestamp).toLocaleTimeString()}
              </span>
            </div>
          </div>
        )}

        {status === 'disconnected' && (
          <p className="text-amber-600 dark:text-amber-400 text-xs leading-relaxed">
            This app is running without Plexo Core. AI features are unavailable.
          </p>
        )}

        {status === 'error' && (
          <p className="text-red-600 dark:text-red-400 text-xs leading-relaxed">
            Could not reach the health endpoint.
          </p>
        )}

        <div className="pt-1 border-t border-border">
          <a
            href="https://getplexo.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Learn more about Plexo →
          </a>
        </div>
      </PopoverContent>
    </Popover>
  )
}
