import { parseProxyBlock, type ParsedProxy } from "@/lib/proxies"
import { FLAGGED_LATENCY_PENALTY_MS, testParsedProxyReachability } from "@/lib/proxy-dispatcher"

// Public, auto-updated proxy lists. ProxyGather (github.com/Skillter/ProxyGather)
// re-scrapes and re-checks every 30 minutes and publishes the survivors as raw
// .txt files, so its "working-*" lists are the highest-signal sources. We also
// pull a couple of other widely-used aggregators for breadth. Every source is a
// plain newline-delimited list of `host:port` (or `proto://host:port`), which
// our existing parseProxyBlock already understands.
type Source = {
  name: string
  url: string
  // Protocol to assume when a line has no scheme prefix (most raw lists are
  // protocol-segregated by file rather than per-line).
  assume: "http" | "socks4" | "socks5"
  // High-signal, small, fast-to-fetch lists (pre-checked "working" exports + a
  // fast CDN). A COLD start fetches only these so the first verified proxies can
  // stream to the client within a second or two instead of blocking on the full
  // ~25-source merge; the complete list is then refreshed in the background.
  priority?: boolean
}

const SOURCES: Source[] = [
  // --- ProxyGather: checked & working (recommended) ---
  {
    name: "ProxyGather HTTP",
    url: "https://raw.githubusercontent.com/Skillter/ProxyGather/refs/heads/master/proxies/working-proxies-http.txt",
    assume: "http",
    priority: true,
  },
  {
    name: "ProxyGather SOCKS5",
    url: "https://raw.githubusercontent.com/Skillter/ProxyGather/refs/heads/master/proxies/working-proxies-socks5.txt",
    assume: "socks5",
    priority: true,
  },
  // --- TheSpeedX / proxy-list (large, frequently updated) ---
  {
    name: "TheSpeedX HTTP",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    assume: "http",
  },
  {
    name: "TheSpeedX SOCKS5",
    url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    assume: "socks5",
  },
  // --- monosans / proxy-list ---
  {
    name: "monosans HTTP",
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    assume: "http",
  },
  // --- proxifly (CDN, updated every ~5 min) ---
  {
    name: "proxifly HTTP",
    url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt",
    assume: "http",
    priority: true,
  },
  {
    name: "proxifly SOCKS5",
    url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt",
    assume: "socks5",
    priority: true,
  },
  // --- monosans SOCKS5 ---
  {
    name: "monosans SOCKS5",
    url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    assume: "socks5",
  },
  // --- ProxyScrape API (free tier, large & frequently refreshed) ---
  {
    name: "ProxyScrape HTTP",
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text",
    assume: "http",
  },
  {
    name: "ProxyScrape SOCKS5",
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=ipport&format=text",
    assume: "socks5",
  },
  // --- jetkai / proxy-list (geo-tagged, large) ---
  {
    name: "jetkai HTTP",
    url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
    assume: "http",
  },
  // --- Zaeem20 / FREE_PROXIES_LIST ---
  {
    name: "Zaeem20 HTTP",
    url: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt",
    assume: "http",
  },
  {
    name: "Zaeem20 SOCKS5",
    url: "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/socks5.txt",
    assume: "socks5",
  },
  // --- ProxyGather HTTPS (checked & working) ---
  {
    name: "ProxyGather HTTPS",
    url: "https://raw.githubusercontent.com/Skillter/ProxyGather/refs/heads/master/proxies/working-proxies-https.txt",
    assume: "http",
    priority: true,
  },
  // --- mmpx12 / proxy-list (updated hourly, large & reliable) ---
  {
    name: "mmpx12 HTTP",
    url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
    assume: "http",
  },
  {
    name: "mmpx12 HTTPS",
    url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt",
    assume: "http",
  },
  {
    name: "mmpx12 SOCKS5",
    url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt",
    assume: "socks5",
  },
  // --- roosterkid / openproxylist (re-validated, RAW exports) ---
  {
    name: "roosterkid HTTPS",
    url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    assume: "http",
  },
  {
    name: "roosterkid SOCKS5",
    url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
    assume: "socks5",
  },
  // --- hookzof / socks5_list (SOCKS5, frequently refreshed) ---
  {
    name: "hookzof SOCKS5",
    url: "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
    assume: "socks5",
  },
  // --- vakhov / fresh-proxy-list (updated every few minutes) ---
  {
    name: "vakhov HTTP",
    url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
    assume: "http",
  },
  {
    name: "vakhov HTTPS",
    url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt",
    assume: "http",
  },
  {
    name: "vakhov SOCKS5",
    url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt",
    assume: "socks5",
  },
]

export type ScrapeSourceResult = {
  name: string
  url: string
  ok: boolean
  count: number
  error?: string
}

export type ScrapeResult = {
  sources: ScrapeSourceResult[]
  parsed: ParsedProxy[]
}

const FETCH_TIMEOUT_MS = 12_000

// socks5 fallback: our schema/dialer only supports http/https/socks5. socks4
// lines (rare in these lists) are treated as socks5 best-effort; if that fails
// the Auto-check tester will simply drop them.
function normalizeAssumed(text: string, assume: Source["assume"]): string {
  if (assume === "http") return text
  // Prefix bare host:port lines so parseProxyLine tags them with the protocol.
  return text
    .split(/\r?\n/)
    .map((l) => {
      const t = l.trim()
      if (!t || t.startsWith("#") || /:\/\//.test(t)) return t
      return `socks5://${t}`
    })
    .join("\n")
}

async function fetchSource(src: Source): Promise<ScrapeSourceResult & { parsed: ParsedProxy[] }> {
  try {
    const res = await fetch(src.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0", accept: "text/plain" },
      cache: "no-store",
    })
    if (!res.ok) {
      return { name: src.name, url: src.url, ok: false, count: 0, error: `HTTP ${res.status}`, parsed: [] }
    }
    const raw = await res.text()
    const parsed = parseProxyBlock(normalizeAssumed(raw, src.assume))
    return { name: src.name, url: src.url, ok: true, count: parsed.length, parsed }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch failed"
    return {
      name: src.name,
      url: src.url,
      ok: false,
      count: 0,
      error: /timed out|aborted/i.test(msg) ? "timed out" : "fetch failed",
      parsed: [],
    }
  }
}

// Fetches every source in parallel and returns the merged, de-duplicated set of
// parsed proxies plus a per-source breakdown. A cap bounds how many we keep so a
// single scrape can't insert hundreds of thousands of rows.
export async function scrapeProxies(opts?: { limit?: number; priorityOnly?: boolean }): Promise<ScrapeResult> {
  const limit = opts?.limit ?? 15_000
  // priorityOnly: fetch just the small, high-signal pre-checked lists (used for a
  // fast cold start so candidates — and therefore the first Netflix-tested proxies
  // — are available within ~1-2s instead of blocking on every aggregator).
  const sources = opts?.priorityOnly ? SOURCES.filter((s) => s.priority) : SOURCES
  const results = await Promise.all(sources.map(fetchSource))

  const seen = new Set<string>()
  const merged: ParsedProxy[] = []
  for (const r of results) {
    for (const p of r.parsed) {
      const key = `${p.protocol}://${p.username ?? ""}@${p.host}:${p.port}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(p)
      if (merged.length >= limit) break
    }
    if (merged.length >= limit) break
  }

  return {
    sources: results.map(({ name, url, ok, count, error }) => ({ name, url, ok, count, error })),
    parsed: merged,
  }
}

export type AliveProxy = { proxy: ParsedProxy; latencyMs: number }

export type FilterAliveResult = {
  tested: number // how many candidates we actually got to probe within budget
  alive: AliveProxy[] // the ones that reached Netflix fast enough
  dead: number // probed but unreachable / blocked / too slow
}

// Reachability-tests parsed proxies IN MEMORY and returns only the alive ones
// (with measured latency), so the caller can persist exclusively working proxies
// — nothing dead ever touches the database. Bounded by both concurrency and a
// wall-clock budget so it stays within the route's maxDuration; any candidates
// not reached before the budget expires are simply left out (not inserted).
export async function filterAliveProxies(
  parsed: ParsedProxy[],
  opts?: {
    concurrency?: number
    slowMs?: number
    budgetMs?: number
    includeFlagged?: boolean
    // Per-candidate probe tuning. The live sweep passes a SINGLE fast attempt so
    // dead proxies are condemned in one short timeout instead of up to 3×, which is
    // what lets the first working proxy surface within a few seconds.
    maxProbeAttempts?: number
    probeTimeoutMs?: number
    // Fires the INSTANT a proxy passes its test, before the whole sweep finishes.
    // Lets a caller STREAM verified proxies to the client as they're found instead
    // of waiting for all candidates to be tested. Still only fires for survivors.
    onAlive?: (proxy: AliveProxy) => void
  },
): Promise<FilterAliveResult> {
  const concurrency = opts?.concurrency ?? 200
  const slowMs = opts?.slowMs ?? 5_000
  const budgetMs = opts?.budgetMs ?? 45_000
  const onAlive = opts?.onAlive
  const probeOpts =
    opts?.maxProbeAttempts !== undefined || opts?.probeTimeoutMs !== undefined
      ? { maxAttempts: opts?.maxProbeAttempts, timeoutMs: opts?.probeTimeoutMs }
      : undefined
  // By default REJECT flagged (403/429) proxies. Netflix is challenging their exit
  // IP, so they'd return 403 on the real account check too — the checker treats
  // that as a proxy failure and fails over, making a flagged proxy pure wasted work
  // (a full request + a failover hop per cookie). Keeping only CLEAN proxies is the
  // single biggest reliability+speed win for bulk runs. Set includeFlagged to keep
  // the old lenient behavior.
  const includeFlagged = opts?.includeFlagged === true
  const startedAt = Date.now()

  const alive: AliveProxy[] = []
  let tested = 0
  let dead = 0

  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, parsed.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= parsed.length) return
      // Stop pulling new work once the time budget is spent.
      if (Date.now() - startedAt >= budgetMs) return
      const p = parsed[i]
      const res = await testParsedProxyReachability(p, probeOpts)
      tested++
      // A proxy counts as usable only if it REACHED Netflix with a CLEAN response
      // (not a 403/429 challenge) within the slowMs cutoff. Flagged proxies are
      // dropped by default (see includeFlagged) because the checker can't use them.
      // The robust probe already retried transient failures, so `ok:false` here is
      // a genuinely unreachable proxy.
      const usable = res.ok && (includeFlagged ? true : !res.flagged) && res.latencyMs <= slowMs
      if (usable) {
        const latencyMs = res.flagged ? res.latencyMs + FLAGGED_LATENCY_PENALTY_MS : res.latencyMs
        const entry: AliveProxy = { proxy: p, latencyMs }
        alive.push(entry)
        onAlive?.(entry) // stream it out immediately, don't wait for the full sweep
      } else {
        dead++
      }
    }
  })
  await Promise.all(workers)

  return { tested, alive, dead }
}
