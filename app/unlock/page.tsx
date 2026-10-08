import type { Metadata } from "next"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import Link from "next/link"
import { BookOpen, Clock, ShieldCheck, Sparkles } from "lucide-react"
import { requestIp } from "@/lib/request-ip"
import { readDeviceId } from "@/lib/device-id"
import { fingerprintFromNextHeaders } from "@/lib/claim-fingerprint"
import { isAccessPassMode, getPass } from "@/lib/access-pass"
import { getClaimAccountId } from "@/lib/generator-auth"
import { isValidLocalGeneratorCookie, LOCAL_COOKIE } from "@/lib/local-generator-auth"
import { claimAllowance } from "@/lib/rate-limit"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { TelegramPromo } from "@/components/telegram-promo"
import { startUnlock } from "@/app/unlock/actions"
import { UnlockSubmitButton } from "@/components/unlock-submit-button"
import type { GeneratorService } from "@/lib/check-via-proxies"

export const metadata: Metadata = {
  title: "Unlock lifetime access — Cookies Mo",
  description:
    "Complete a secure unlock step for gateway-free account generation. Access remains subject to service limits and can be revoked by an admin.",
}

export const dynamic = "force-dynamic"

const SERVICE_LABEL: Record<GeneratorService, string> = {
  netflix: "Netflix",
  prime: "Prime Video",
  crunchyroll: "Crunchyroll",
}

function asService(value: unknown): GeneratorService {
  return value === "prime" ? "prime" : value === "crunchyroll" ? "crunchyroll" : "netflix"
}

function generatorHref(service: GeneratorService): string {
  return service === "prime"
    ? "/prime/account-generator"
    : service === "crunchyroll"
      ? "/crunchyroll/account-generator"
      : "/account-generator"
}

export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ service?: string; error?: string }> }) {
  const { service: serviceParam, error } = await searchParams
  const service = asService(serviceParam)
  const sessionCookies = await cookies()
  const signedIn = Boolean(
    sessionCookies.get("cm_telegram_subject")?.value ||
      sessionCookies.get("cm_lifetime_session")?.value ||
      isValidLocalGeneratorCookie(sessionCookies.get(LOCAL_COOKIE)?.value),
  )
  if (!signedIn) {
    redirect(`/login?next=${encodeURIComponent(`/unlock?service=${service}`)}`)
  }

  // Feature OFF → there's no pass concept; the generator runs its normal per-account
  // gateway, so send the user straight there.
  if (!(await isAccessPassMode())) redirect(generatorHref(service))

  const [ip, deviceId] = await Promise.all([requestIp(), readDeviceId()])
  const pass = await getPass(deviceId)
  // Already holds a valid pass → nothing to unlock, go generate.
  if (pass.valid) redirect(generatorHref(service))

  // Surface whether they're currently at a service cap so the copy stays honest — the
  // pass removes the gateway, never the per-service claim limit.
  const fingerprint = await fingerprintFromNextHeaders(ip)
  // Match the website generator/status bucket. Previously this page checked only
  // the device bucket, so it could say "claim limit reached" while Telegram's
  // Website Status correctly showed 0/2 (or vice versa).
  const accountClaimId = await getClaimAccountId()
  const allowance = await claimAllowance(service, ip, deviceId, fingerprint, undefined, accountClaimId)
  const label = SERVICE_LABEL[service]

  return (
    <main className="flex min-h-svh flex-col text-foreground">
      <SiteHeader cta="checker" service={service} />

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-10 sm:px-6 sm:py-14">
        <div className="flex flex-col gap-3">
          <h1 className="text-balance text-4xl font-semibold uppercase leading-[0.95] tracking-tight sm:text-5xl">
            Unlock{" "}
            <span className="inline-block border border-border bg-primary px-2 text-primary-foreground shadow-lg">
              24 hours
            </span>{" "}
            of access
          </h1>
          <p className="max-w-2xl text-pretty text-base font-medium leading-relaxed text-muted-foreground">
            Complete one quick step, then use the {label} generator without repeating it for 24 hours.
          </p>
          <TelegramPromo />
        </div>

        {/* Benefit row */}
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            { icon: Sparkles, title: "Bind once", desc: "One device per key." },
            { icon: Clock, title: "24-hour access", desc: "No repeat unlocks." },
            { icon: ShieldCheck, title: "Service limits", desc: "Live checks still apply." },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex flex-col gap-2 border border-border bg-card p-4">
              <Icon className="size-5 text-accent" aria-hidden />
              <span className="text-sm font-semibold uppercase tracking-tight text-foreground">{title}</span>
              <span className="text-xs font-medium leading-relaxed text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>

        {/* Action card */}
        <div className="mt-8 flex flex-col gap-6 border border-border bg-card p-6 shadow-xl sm:p-8">
          <div className="flex flex-col gap-1">
            <span className="text-lg font-semibold uppercase tracking-widest text-foreground">
              Ready to unlock {label}?
            </span>
            <span className="text-sm font-medium leading-relaxed text-muted-foreground">
              Your account is signed in. Complete the quick unlock step to continue to the {label} generator for 24 hours.
            </span>
          </div>

          {!allowance.allowed && (
            <p className="border border-border bg-muted px-4 py-3 text-xs font-medium leading-relaxed text-muted-foreground">
              Note: you&apos;re currently at the {label} claim limit. Unlocking removes the extra step, but the
              per-service limit still applies while it resets.
            </p>
          )}

          {error && <p className="border border-destructive bg-destructive/10 px-4 py-3 text-xs font-medium text-destructive">{error}</p>}

          <form action={startUnlock}>
            <input type="hidden" name="service" value={service} />
            <UnlockSubmitButton label={label} />
          </form>

          <Link
            href="/unlock-guide"
            className="flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
          >
            <BookOpen className="size-4" aria-hidden />
            How to unlock for free
          </Link>
        </div>
      </div>

      <div className="mt-auto">
        <SiteFooter />
      </div>
    </main>
  )
}
