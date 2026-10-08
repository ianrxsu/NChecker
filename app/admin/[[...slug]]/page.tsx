import { redirect } from "next/navigation"
import { getAdminRole } from "@/lib/admin-auth"
import { getMetrics, emptySnapshot as EMPTY_METRICS } from "@/lib/metrics"
import { getClaimAnalytics, emptyClaimAnalytics as EMPTY_CLAIMS } from "@/lib/claim-analytics"
import { getSystemStatus, fallbackSystemStatus as FALLBACK_SYSTEM } from "@/lib/system-status"
import { redisEnabled } from "@/lib/redis"
import { ADMIN_SECTIONS, type SectionId } from "@/lib/admin-sections"
import { AdminPanel } from "@/components/admin/admin-panel"

export const dynamic = "force-dynamic"

// Path-based admin routing: the section (and, for the checkers, the bulk/single
// mode) live in the URL path instead of ?tab=/&mode= query params:
// /admin → overview
// /admin/system → system
// /admin/checker → Netflix checker, single mode
// /admin/checker/bulk → Netflix checker, bulk mode
// /admin/prime-checker/bulk, /admin/crunchyroll-checker/bulk, …
//
// This is an optional catch-all so all of the above resolve to the same panel,
// server-rendering the correct section on first paint. The static /admin/login
// route still takes precedence over this catch-all.
export default async function AdminPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const role = await getAdminRole()
  if (!role) {
    redirect("/admin/login")
  }

  const { slug } = await params
  const requested = slug?.[0]
  const moderatorAllowed = new Set<SectionId>(["checker", "saved", "prime-checker", "prime-saved", "crunchyroll-checker", "crunchyroll-saved"])
  const initialSection: SectionId = role === "moderator" && !moderatorAllowed.has(requested as SectionId)
    ? "checker"
    : ADMIN_SECTIONS.includes(requested as SectionId)
    ? (requested as SectionId)
    : "overview"
  const initialCheckerMode = slug?.[1] === "bulk" ? "bulk" : "single"

  // Resilient render: a transient failure in EITHER data source must not 500 the
  // whole panel (the bare "This page couldn't load" screen). getMetrics already
  // degrades to an empty snapshot internally; allSettled covers any other throw so
  // the panel always renders and the client can refresh live data afterward.
  const [metricsRes, systemRes, claimsRes] = await Promise.allSettled([
    getMetrics(),
    getSystemStatus(),
    getClaimAnalytics(),
  ])
  const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : EMPTY_METRICS
  const system = systemRes.status === "fulfilled" ? systemRes.value : FALLBACK_SYSTEM
  const claims = claimsRes.status === "fulfilled" ? claimsRes.value : EMPTY_CLAIMS
  return (
    <AdminPanel
      initialData={{ metrics, system, claims, redisEnabled, generatedAt: Date.now() }}
      initialSection={initialSection}
      initialCheckerMode={initialCheckerMode}
      role={role}
    />
  )
}
