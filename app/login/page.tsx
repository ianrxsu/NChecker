import Link from "next/link"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { redis, redisEnabled } from "@/lib/redis"
import { signInWithLifetimeKey } from "@/app/unlock/actions"
import { LifetimeKeyLoginButton } from "@/components/lifetime-key-login-button"
import { LoadingLink, TelegramLoginButton } from "@/components/login-action-buttons"

export const dynamic = "force-dynamic"

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/account-generator"
  const sessionCookies = await cookies()
  const telegramUser = sessionCookies.get("cm_telegram_subject")?.value
  const lifetimeSession = sessionCookies.get("cm_lifetime_session")?.value
  const revoked = Boolean(telegramUser && redisEnabled && (await redis.get(`logout:telegram:${telegramUser}`)))
  if ((telegramUser && !revoked) || lifetimeSession) redirect(safeNext)
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center px-4 py-12">
      <div className="border border-border bg-card p-6 shadow-xl sm:p-8">
        <Link href="/" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground">Cookies Mo</Link>
        <h1 className="mt-4 text-3xl font-semibold uppercase tracking-tight">Sign in to continue</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Free access requires a Telegram-linked website account. Lifetime key holders can sign in directly with their key.</p>
        {error && <p className="mt-4 border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <TelegramLoginButton />
        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground"><span className="h-px flex-1 bg-border" />or lifetime key<span className="h-px flex-1 bg-border" /></div>
        <form action={signInWithLifetimeKey} className="flex flex-col gap-3">
          <input type="hidden" name="next" value={safeNext} />
          <input name="accessCode" required autoComplete="off" placeholder="Enter your access key" className="min-h-11 border border-border bg-background px-4 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <LifetimeKeyLoginButton />
        </form>
        <p className="mt-6 text-center text-sm leading-relaxed text-muted-foreground">You can buy lifetime keys for cheap price just dm: <a href="https://t.me/kasumichwan" className="font-semibold text-foreground underline underline-offset-4">@kasumichwan</a> on Telegram.</p>
        <LoadingLink href="/" className="mt-6 block text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground">Back home</LoadingLink>
      </div>
    </main>
  )
}
