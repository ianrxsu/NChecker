import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { isValidLocalGeneratorCookie, LOCAL_COOKIE } from "@/lib/local-generator-auth"

export async function requireGeneratorLogin(nextPath: string) {
  const sessionCookies = await cookies()
  const signedIn = Boolean(
    sessionCookies.get("cm_telegram_subject")?.value ||
      sessionCookies.get("cm_lifetime_session")?.value ||
      isValidLocalGeneratorCookie(sessionCookies.get(LOCAL_COOKIE)?.value),
  )

  if (!signedIn) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`)
  }
}

// Returns the website-specific identity for claim-limit buckets. The `web:` and
// `bot:` namespaces are intentional: website and Telegram bot usage must remain
// separate, even when they belong to the same Telegram account or lifetime key.
// Returns undefined for a signed-out visitor (device-only bucket).
export async function getClaimAccountId(): Promise<string | undefined> {
  const sessionCookies = await cookies()
  const telegramSubject = sessionCookies.get("cm_telegram_subject")?.value
  if (telegramSubject) return `web:tg:${telegramSubject}`
  const lifetimeSession = sessionCookies.get("cm_lifetime_session")?.value
  if (lifetimeSession) return `web:lt:${lifetimeSession}`
  return undefined
}
