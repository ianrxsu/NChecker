import { cookies } from "next/headers"
import { redirect } from "next/navigation"

// The selection flow moved to /account-generator. Preserve any old links.
export default async function RewardRedirect() {
  const sessionCookies = await cookies()
  const signedIn = Boolean(sessionCookies.get("cm_telegram_subject")?.value || sessionCookies.get("cm_lifetime_session")?.value)
  redirect(signedIn ? "/account-generator" : "/login?next=%2Faccount-generator")
}
