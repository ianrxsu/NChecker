// Pure, stateless proxy PARSING + dialing helpers. There is intentionally NO
// database here: free proxies die within minutes, so persisting them is
// pointless. The app's only proxy source is live scraping (see
// lib/proxy-scraper.ts + lib/live-proxies.ts on the client and
// lib/server-live-proxies.ts on the server), which scrapes, Netflix-tests, and
// hands back only the fastest WORKING proxies on demand.

export type ProxyProtocol = "http" | "https" | "socks5"

// A parsed proxy line. `password`/`username` are only ever populated for the rare
// authed source line; scraped free proxies have neither.
export type ParsedProxy = {
  protocol: ProxyProtocol
  host: string
  port: number
  username: string | null
  password: string | null
}

// The connection details the server needs to dial a proxy through undici/socks.
export type ProxyDialInfo = {
  id: string
  protocol: ProxyProtocol
  host: string
  port: number
  username: string | null
  password: string | null
  isGateway?: boolean
}

// Parses a single proxy line in any of the common formats:
//   host:port
//   host:port:user:pass
//   protocol://host:port
//   protocol://user:pass@host:port
//   user:pass@host:port
// Returns null for blank/comment/invalid lines so a list of mixed junk is
// tolerated (bad lines are simply skipped).
export function parseProxyLine(raw: string): ParsedProxy | null {
  // Accept proxy lists copied from CSVs, browser exports, or space-separated
  // lists; comments and trailing metadata are ignored.
  const line = raw.trim().replace(/[;,\t]+/g, ":")
  if (!line || line.startsWith("#") || line.startsWith("//")) return null

  let protocol: ProxyProtocol = "http"
  let rest = line
  const schemeMatch = rest.match(/^([a-z0-9]+):\/\//i)
  if (schemeMatch) {
    const proto = schemeMatch[1].toLowerCase()
    if (proto === "socks" || proto === "socks4" || proto === "socks5" || proto === "socks5h") protocol = "socks5"
    else if (proto === "https") protocol = "https"
    else if (proto === "http") protocol = "http"
    else return null
    rest = rest.slice(schemeMatch[0].length)
  }

  let username: string | null = null
  let password: string | null = null
  const atIdx = rest.lastIndexOf("@")
  if (atIdx !== -1) {
    const creds = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
    const ci = creds.indexOf(":")
    username = decodeProxyPart(ci === -1 ? creds : creds.slice(0, ci)) || null
    password = ci === -1 ? null : decodeProxyPart(creds.slice(ci + 1)) || null
  }

  // Supports host:port, host:port:user:pass, user:pass:host:port, and IPv6
  // literals in [brackets]. Prefer the final numeric token as the port.
  const bracketed = rest.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)(?::(.+))?$/)
  if (bracketed) {
    const host = (bracketed[1] ?? bracketed[2]).trim()
    const port = Number(bracketed[3])
    const tail = bracketed[4]
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null
    if (username === null && tail) {
      const fields = tail.split(":")
      username = decodeProxyPart(fields[0]) || null
      password = decodeProxyPart(fields.slice(1).join(":")) || null
    }
    return { protocol, host, port, username, password }
  }

  const fields = rest.split(":").map((part) => part.trim())
  const portIndex = fields.findIndex((part) => /^\d{1,5}$/.test(part))
  if (portIndex < 0) return null
  const port = Number(fields[portIndex])
  if (port < 1 || port > 65535) return null
  let host = fields[portIndex - 1]
  if (!host) return null
  if (username === null && portIndex >= 2) {
    username = decodeProxyPart(fields[0]) || null
    password = decodeProxyPart(fields[1]) || null
    host = fields[portIndex - 1]
  }
  return { protocol, host, port, username, password }
}

function decodeProxyPart(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

// Parses a whole block into unique parsed proxies (dedup by
// protocol+host+port+username).
export function parseProxyBlock(text: string): ParsedProxy[] {
  const seen = new Set<string>()
  const out: ParsedProxy[] = []
  for (const line of text.split(/\r?\n/)) {
    const p = parseProxyLine(line)
    if (!p) continue
    const key = `${p.protocol}://${p.username ?? ""}@${p.host}:${p.port}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

// Builds the proxy URL string undici's ProxyAgent / socks-proxy-agent expects.
export function proxyUrl(p: ProxyDialInfo): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? "")}@` : ""
  return `${p.protocol}://${auth}${p.host}:${p.port}`
}
