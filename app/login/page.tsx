import Link from "next/link"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { redis, redisEnabled } from "@/lib/redis"
import { redeemUnlockCode } from "@/app/unlock/actions"
import { LifetimeKeyLoginButton } from "@/components/lifetime-key-login-button"

export const dynamic = "force-dynamic"

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/account-generator"
  const telegramUser = (await cookies()).get("cm_telegram_subject")?.value
  const revoked = Boolean(telegramUser && redisEnabled && (await redis.get(`logout:telegram:${telegramUser}`)))
  if (telegramUser && !revoked) redirect(safeNext)
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center px-4 py-12">
      <div className="border border-border bg-card p-6 shadow-xl sm:p-8">
        <Link href="/" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground">Cookies Mo</Link>
        <h1 className="mt-4 text-3xl font-semibold uppercase tracking-tight">Sign in to continue</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Free access requires a Telegram-linked website account. Lifetime key holders can sign in directly with their key.</p>
        {error && <p className="mt-4 border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <a href="https://t.me/cookiesmo_bot?start=website_login" className="mt-6 flex min-h-11 items-center justify-center bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Quick login with Telegram</a>
        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-widest text-muted-foreground"><span className="h-px flex-1 bg-border" />or lifetime key<span className="h-px flex-1 bg-border" /></div>
        <form action={redeemUnlockCode} className="flex flex-col gap-3">
          <input type="hidden" name="service" value="netflix" />
          <input name="accessCode" required autoComplete="off" placeholder="Enter your access key" className="min-h-11 border border-border bg-background px-4 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <LifetimeKeyLoginButton />
        </form>
        <Link href="/" className="mt-6 block text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground">Back home</Link>
      </div>
    </main>
  )
}
