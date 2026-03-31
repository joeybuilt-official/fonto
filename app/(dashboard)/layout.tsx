import Link from 'next/link'
import { PlexoConnectionStatus } from '@/components/plexo/PlexoConnectionStatus'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen">
      <aside className="flex w-60 flex-col border-r border-border bg-muted/40">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Link href="/" className="text-sm font-semibold">
            App Starter
          </Link>
        </div>

        <nav className="flex-1 space-y-1 px-2 py-3">
          <Link
            href="/dashboard"
            className="flex items-center rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Dashboard
          </Link>
        </nav>

        <div className="border-t border-border px-3 py-3">
          <PlexoConnectionStatus />
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  )
}
