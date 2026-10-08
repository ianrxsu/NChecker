import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { Clock, ShieldCheck, Sparkles } from "lucide-react"
import { requestIp } from "@/lib/request-ip"
import { readDeviceId } from "@/lib/device-id"
import { fingerprintFromNextHeaders } from "@/lib/claim-fingerprint"
import { isAccessPassMode } from "@/lib/access-pass"
import { claimAllowance } from "@/lib/rate-limit"
import { SiteHeader } from "@/components/site-header"
import { SiteFooter } from "@/components/site-footer"
import { TelegramPromo } from "@/components/telegram-promo"
import { startUnlock } from "@/app/unlock/actions"
import { UnlockSubmitButton } from "@/components/unlock-submit-button"
import type { GeneratorService } from "@/lib/check-via-proxies"

export const metadata: Metadata = {
  title: "NF Checker — 24-Hour Access",
  description:
    "Unlock the NF checker for 24 hours and verify Netflix cookies through the protected checker.",
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
      : "/netflix"
}

export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ service?: string; error?: string }> }) {
  const { service: serviceParam, error } = await searchParams
  const service = asService(serviceParam)

  // Netflix is always protected by the 24-hour pass. Other services retain the
  // admin-controlled toggle used by their existing generator flows.
  if ((service === "prime" || service === "crunchyroll") && !(await isAccessPassMode())) {
    redirect(generatorHref(service))
  }

  const [ip, deviceId] = await Promise.all([requestIp(), readDeviceId()])
  // Keep this page renderable even when a pass exists. Redirecting back to the
  // gated checker here can create a loop if browser cookies are out of sync.

  // Surface whether they're currently at a service cap so the copy stays honest — the
  // pass removes the gateway, never the per-service claim limit.
  const fingerprint = await fingerprintFromNextHeaders(ip)
  const allowance = await claimAllowance(service, ip, deviceId, fingerprint)
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
            Complete one quick step to unlock the NF checker and verify Netflix cookies for 24 hours.
          </p>
          <TelegramPromo />
        </div>

        {/* Benefit row */}
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            { icon: Sparkles, title: "Bind once", desc: "One browser for 24 hours." },
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
        <div className="mt-8 flex flex-col gap-6 rounded-3xl border border-border bg-card p-6 text-card-foreground sm:p-8">
          <div className="flex flex-col gap-1">
            <span className="text-lg font-semibold uppercase tracking-widest text-foreground">
              Ready to unlock {label}?
            </span>
            <span className="text-sm font-medium leading-relaxed text-muted-foreground">
              Unlock the NF checker for 24 hours.
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

        </div>
      </div>

      <div className="mt-auto">
        <SiteFooter />
      </div>
    </main>
  )
}
