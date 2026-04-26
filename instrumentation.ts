/**
 * Next.js instrumentation hook — runs once at server startup.
 * Used to register Fonto with Plexo Core on boot.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerWithPlexoCore } = await import("./lib/plexo-registration")
    await registerWithPlexoCore()
  }
}
