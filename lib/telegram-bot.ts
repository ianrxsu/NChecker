import "server-only"

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { verifyPassword } from "@/lib/admin-auth"
import { getTelegramWebhookSecret } from "@/lib/telegram-settings"
import { claimAllowance, recordClaim, consumeTelegramAction, clearFreeClaimBuckets, clearAllClaimBuckets } from "@/lib/rate-limit"
import { getClaimLimits } from "@/lib/claim-limits"
import { distributeAccount, getPoolOptions, getTelegramPoolSummary } from "@/lib/reward-distribution"
import { toGrantedAccount } from "@/lib/granted-account"
import { type GeneratorService } from "@/lib/check-via-proxies"
import { cookieToCookieEditorJson, cookieToNetscape } from "@/lib/cookie-utils"
import { getAccessCode, getAccessCodeByValue, getAccessCodeLimits, redeemAccessCode, resetRedemptionForDevice } from "@/lib/access-codes"
import { getPass, grantLifetimePass, grantPass } from "@/lib/access-pass"
import { buildShortXLinksReturnUrl, shortenWithShortXLinks } from "@/lib/shortxlinks"
import { requestIp } from "@/lib/request-ip"
import { importCookieFiles } from "@/lib/file-import"
import { createProxyPoolChecker } from "@/lib/check-via-proxies"
import { getServerLiveProxies } from "@/lib/server-live-proxies"
import { prepareCookieForCheck, isAliveResult, buildAccountDetails, joinAccountDetails } from "@/lib/cookie-utils"
import type { CheckResult } from "@/lib/normalize-upstream"
import { saveAliveCookies } from "@/lib/saved-cookies"
import { saveAlivePrimeCookies } from "@/lib/saved-prime-cookies"
import { saveAliveCrunchyrollCookies } from "@/lib/saved-crunchyroll-cookies"

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const MAX_MESSAGE = 4096

async function isTelegramAdmin(userId: string): Promise<boolean> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  return redisEnabled ? Boolean(await redis.get(`telegram:admin:${userId}`)) : false
}

async function setTelegramAdmin(userId: string): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) await redis.set(`telegram:admin:${userId}`, randomBytes(32).toString("hex"))
}

async function clearTelegramAdmin(userId: string): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) await redis.del(`telegram:admin:${userId}`)
}

export async function recordTelegramUser(userId: string): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) await redis.sadd("telegram:stats:users", userId)
}

export async function incrementTelegramStat(stat: "unlocks" | "generations"): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) await redis.incr(`telegram:stats:${stat}`)
}

  async function getTelegramStats(): Promise<{ users: number; unlocks: number; generations: number; today: number } | null> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return null
  const [users, unlocks, generations] = await Promise.all([
    redis.scard("telegram:stats:users"),
    redis.get<number>("telegram:stats:unlocks"),
    redis.get<number>("telegram:stats:generations"),
  ])
  const { getDailyCompletionStats } = await import("@/lib/daily-completion-stats")
  const daily = await getDailyCompletionStats()
  return { users, unlocks: Number(unlocks || 0), generations: Number(generations || 0), today: daily.telegram }
  }

const TELEGRAM_BOT_DISABLED_KEY = "telegram:bot:disabled"

async function setTelegramBotDisabled(disabled: boolean): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return
  if (disabled) await redis.set(TELEGRAM_BOT_DISABLED_KEY, "1")
  else await redis.del(TELEGRAM_BOT_DISABLED_KEY)
}

async function isTelegramBotDisabled(): Promise<boolean> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  return redisEnabled ? Boolean(await redis.get(TELEGRAM_BOT_DISABLED_KEY)) : false
}

async function resetTelegramUserAccess(userId: string): Promise<number> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return 0
  const device = deviceId(userId)
  const activeShortxToken = await redis.get<string>(`telegram:shortx:active:${userId}`)
  const keys = [
    `telegram:awaiting-redeem:${userId}`,
    `telegram:action:${userId}`,
    `telegram:button:${userId}`,
    `telegram:callback:${userId}`,
    `telegram:menus:${userId}`,
    `telegram:interactions:${userId}`,
    `telegram:key-limits:${userId}`,
    `telegram:shortx:${userId}`,
    `telegram:shortx:active:${userId}`,
    `telegram:shortx:daily:${userId}`,
    `telegram:unlock:${userId}`,
    `telegram:daily:${userId}`,
    `pass:${device}`,
    `pass:${userId}`,
    `pass-expiry:${device}`,
    `pass-reset-notified:${device}`,
    ...(activeShortxToken ? [`telegram:shortx:pending:${activeShortxToken}`] : []),
  ]
  await clearAllClaimBuckets(device, SERVICES.map(({ id: service }) => service))
  return redis.del(...keys)
}

function adminCommand(raw: string): string | null {
  const match = raw.match(/^\/?admin_(.+)$/i)
  return match?.[1] || null
}

const SERVICES: Array<{ id: GeneratorService; label: string }> = [
  { id: "netflix", label: "Netflix" },
  { id: "prime", label: "Prime Video" },
  { id: "crunchyroll", label: "Crunchyroll" },
]

type TelegramUpdate = {
  update_id?: unknown
  message?: {
    message_id?: unknown
    chat?: { id?: unknown }
    from?: { id?: unknown }
    text?: unknown
    document?: { file_id?: unknown; file_name?: unknown; file_size?: unknown }
  }
  callback_query?: { id?: unknown; data?: unknown; from?: { id?: unknown }; message?: { message_id?: unknown; chat?: { id?: unknown } } }
}

const REQUIRED_GROUP_ID = "-1004318173503"
const REQUIRED_GROUP_LINK = "https://t.me/+GGANKCF7fsg2YjVl"
const localActions = new Set<string>()

async function isTelegramMember(userId: string): Promise<boolean> {
  try {
    const result = await telegram("getChatMember", { chat_id: REQUIRED_GROUP_ID, user_id: userId })
    const status = result?.status
    return status === "creator" || status === "administrator" || status === "member" || (status === "restricted" && result?.is_member === true)
  } catch (error) {
    console.error("[telegram] membership check failed", error)
    return false
  }
}

async function requireTelegramMembership(chatId: string, userId: string): Promise<boolean> {
  if (await isTelegramMember(userId)) return true
  await send(chatId, "Please join the required group before using this bot.", {
    inline_keyboard: [[{ text: "Join required group", url: REQUIRED_GROUP_LINK }]],
  })
  return false
}

async function beginAction(userId: string): Promise<boolean> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) return Boolean(await redis.set(`telegram:action:${userId}`, "1", { nx: true, ex: 120 }))
  if (localActions.has(userId)) return false
  localActions.add(userId)
  return true
}

async function endAction(userId: string): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) await redis.del(`telegram:action:${userId}`)
  localActions.delete(userId)
}

async function claimButtonClick(userId: string, messageId: unknown): Promise<boolean> {
  if (typeof messageId !== "number") return true
  const key = `telegram:button:${userId}:${messageId}`
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) return Boolean(await redis.set(key, "1", { nx: true, ex: 900 }))
  return true
}

function id(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null
}

function deviceId(userId: string): string {
  return `telegram:${createHash("sha256").update(userId).digest("hex")}`
}

async function getTelegramAccessState(userId: string, admin = false): Promise<{ valid: boolean; lifetime: boolean; expiresAt: number | null }> {
  if (admin) return { valid: true, lifetime: false, expiresAt: null }
  const pass = await getPass(deviceId(userId))
  return { valid: pass.valid, lifetime: Boolean(pass.accessCodeId), expiresAt: pass.expiresAt }
}

async function resetExpiredTelegramLimits(userId: string): Promise<boolean> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return false
  const device = deviceId(userId)
  const expiry = Number(await redis.get<number | string>(`pass-expiry:${device}`))
  if (!Number.isFinite(expiry) || expiry <= 0 || expiry > Date.now()) return false
  const pass = await getPass(device)
  if (pass.valid) return false
  const marker = `pass-reset-notified:${device}`
  const claimed = await redis.set(marker, "1", { nx: true, ex: 86400 })
  if (!claimed) return false
  await clearFreeClaimBuckets(device, SERVICES.map(({ id: service }) => service))
  await redis.del(`pass-expiry:${device}`)
  return true
}

  async function hasTelegramDailyUnlock(userId: string): Promise<boolean> {
  return (await getPass(deviceId(userId))).valid
  }

  async function telegramUnlockExpiresAt(userId: string): Promise<Date | null> {
  const pass = await getPass(deviceId(userId))
  return pass.expiresAt ? new Date(pass.expiresAt) : null
  }

async function createTelegramUnlock(chatId: string, userId: string, service: GeneratorService): Promise<string | null> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) {
    console.error("[v0] Telegram unlock unavailable: Redis is not configured")
    return null
  }
  if (!process.env.TELEGRAM_SHORTXLINKS_API_TOKEN) {
    console.error("[v0] Telegram unlock unavailable: TELEGRAM_SHORTXLINKS_API_TOKEN is missing")
    return null
  }

  const activeToken = await redis.get<string>(`telegram:shortx:active:${userId}`)
  // A failed API request must never permanently block retries for this user.
  // Clean up any stale pending token before creating a fresh unlock attempt.
  if (activeToken) {
    await redis.del(`telegram:shortx:active:${userId}`, `telegram:shortx:pending:${activeToken}`)
  }
  const token = randomUUID()
  await redis.set(`telegram:shortx:pending:${token}`, { chatId, userId, service }, { ex: 3600 })
  await redis.set(`telegram:shortx:active:${userId}`, token, { ex: 3600 })
  try {
    const configuredOrigin = "https://cookiesmo.i4n.tech"
    const returnUrl = buildShortXLinksReturnUrl(configuredOrigin, token)
    const result = await shortenWithShortXLinks(returnUrl, process.env.TELEGRAM_SHORTXLINKS_API_TOKEN)
    if (!result.ok) {
      console.error("[v0] Telegram ShortXLinks API failed:", result.error)
      await redis.del(`telegram:shortx:active:${userId}`, `telegram:shortx:pending:${token}`)
      return null
    }
    return result.url
  } catch (error) {
    console.error("[v0] Telegram gateway URL generation failed:", error)
    await redis.del(`telegram:shortx:active:${userId}`, `telegram:shortx:pending:${token}`)
    return null
  }
}

function serviceFrom(value: unknown): GeneratorService | null {
  return value === "netflix" || value === "prime" || value === "crunchyroll" ? value : null
}

async function telegram(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured")
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  const payload = await response.json().catch(() => null) as { ok?: boolean; result?: Record<string, unknown>; description?: string } | null
  if (!response.ok || payload?.ok === false) {
    throw new Error(`Telegram API ${method} failed: ${response.status}${payload?.description ? ` (${payload.description})` : ""}`)
  }
  return payload?.result || null
}

async function deleteMessage(chatId: string, messageId: unknown): Promise<void> {
  if (typeof messageId !== "number") return
  await telegram("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => undefined)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

async function telegramFile(fileId: string): Promise<{ name: string; bytes: Uint8Array }> {
  const file = await telegram("getFile", { file_id: fileId })
  const path = typeof file?.file_path === "string" ? file.file_path : ""
  if (!BOT_TOKEN || !path) throw new Error("Telegram file path unavailable")
  const response = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`, { cache: "no-store" })
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`)
  return { name: path.split("/").pop() || "telegram-upload.txt", bytes: new Uint8Array(await response.arrayBuffer()) }
}

function telegramBulkService(userId: string): Promise<GeneratorService | null> {
  return import("@/lib/redis").then(async ({ redis, redisEnabled }) => {
    if (!redisEnabled) return null
    return (await redis.get<GeneratorService>(`telegram:bulk:service:${userId}`)) || null
  })
}

const telegramCheckKey = (userId: string) => `telegram:checker:state:${userId}`
type TelegramCheckState = "running" | "paused" | "cancelled" | "restart"

async function getTelegramCheckState(userId: string): Promise<TelegramCheckState> {
  const { redis } = await import("@/lib/redis")
  return (await redis.get<TelegramCheckState>(telegramCheckKey(userId))) || "running"
}

async function setTelegramCheckState(userId: string, state: TelegramCheckState) {
  const { redis } = await import("@/lib/redis")
  await redis.set(telegramCheckKey(userId), state, { ex: 86400 })
}

// Tracks whether a bulk check is actually in flight for this admin, separate from
// the pause/resume/cancel state above. Pause/resume/stop/cancel/restart must only
// take effect while a check is running — otherwise they are no-ops.
const telegramCheckActiveKey = (userId: string) => `telegram:checker:active:${userId}`

async function isTelegramCheckActive(userId: string): Promise<boolean> {
  const { redis } = await import("@/lib/redis")
  return Boolean(await redis.get(telegramCheckActiveKey(userId)))
}

async function setTelegramCheckActive(userId: string, active: boolean) {
  const { redis } = await import("@/lib/redis")
  if (active) await redis.set(telegramCheckActiveKey(userId), "1", { ex: 3600 })
  else await redis.del(telegramCheckActiveKey(userId))
}

// Inline control keyboard shown alongside checking/progress messages so an admin
// can tap instead of typing commands. Pause/Resume toggles its label based on the
// current checker state.
const checkerControlKeyboard = (state: TelegramCheckState) => ({
  inline_keyboard: [
    [
      state === "paused"
        ? { text: "Resume", callback_data: "command:resume" }
        : { text: "Pause", callback_data: "command:pause" },
      { text: "Restart", callback_data: "command:restart" },
    ],
    [{ text: "Stop", callback_data: "command:stop" }],
  ],
})

// Telegram delivers each uploaded document as its own message/update, so sending
// several files "in one go" arrives as several back-to-back webhook calls. To
// merge them into a single check, every document is queued into a shared Redis
// list keyed to the admin; whichever call first finds the queue empty becomes the
// "batch owner" (via an atomic NX lock) and waits out a short debounce window for
// any sibling uploads to land before downloading everything and running one merged,
// deduplicated check. Every other call for the same batch just enqueues and returns.
const telegramBulkBatchKey = (userId: string) => `telegram:bulk:batch:${userId}`
const telegramBulkBatchTouchedKey = (userId: string) => `telegram:bulk:batch:touched:${userId}`
const telegramBulkBatchOwnerKey = (userId: string) => `telegram:bulk:batch:owner:${userId}`
const BULK_BATCH_DEBOUNCE_MS = 4000
const BULK_BATCH_TTL_SECONDS = 300

type TelegramBulkBatchEntry = { fileId: string; name: string }

// Enqueues one uploaded file and reports whether THIS call won the owner lock
// (meaning it is responsible for waiting out the debounce and running the check).
async function enqueueTelegramBulkFile(userId: string, entry: TelegramBulkBatchEntry): Promise<boolean> {
  const { redis } = await import("@/lib/redis")
  await redis.rpush(telegramBulkBatchKey(userId), JSON.stringify(entry))
  await redis.expire(telegramBulkBatchKey(userId), BULK_BATCH_TTL_SECONDS)
  await redis.set(telegramBulkBatchTouchedKey(userId), Date.now(), { ex: BULK_BATCH_TTL_SECONDS })
  const acquired = await redis.set(telegramBulkBatchOwnerKey(userId), "1", { nx: true, ex: BULK_BATCH_TTL_SECONDS })
  return Boolean(acquired)
}

// Waits until no new file has been queued for BULK_BATCH_DEBOUNCE_MS, then drains
// and returns every queued entry (clearing the queue and the owner lock).
async function drainTelegramBulkBatch(userId: string): Promise<TelegramBulkBatchEntry[]> {
  const { redis } = await import("@/lib/redis")
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const touched = Number(await redis.get(telegramBulkBatchTouchedKey(userId))) || 0
    if (Date.now() - touched >= BULK_BATCH_DEBOUNCE_MS) break
  }
  // Upstash Redis can return list members as already-decoded objects when the
  // client is typed as an object, while older members may still be JSON strings.
  // Never call JSON.parse on an object — that caused the RAR upload failure:
  // `"[object Object]" is not valid JSON`.
  const raw = (await redis.lrange<unknown>(telegramBulkBatchKey(userId), 0, -1)) || []
  await redis.del(telegramBulkBatchKey(userId))
  await redis.del(telegramBulkBatchTouchedKey(userId))
  await redis.del(telegramBulkBatchOwnerKey(userId))
  const entries: TelegramBulkBatchEntry[] = []
  for (const value of raw) {
    try {
      const entry = typeof value === "string" ? JSON.parse(value) : value
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as TelegramBulkBatchEntry).fileId === "string" &&
        typeof (entry as TelegramBulkBatchEntry).name === "string"
      ) {
        entries.push(entry as TelegramBulkBatchEntry)
      }
    } catch (error) {
      console.warn("[telegram] Ignoring malformed bulk batch entry", error)
    }
  }
  return entries
}

// Persists alive hits to the correct per-service saved pool, mirroring the
// website's autoSaveAlive. Swallows storage errors so a DB hiccup never breaks
// the run's reporting.
async function saveAliveForService(service: GeneratorService, entries: { cookie: string; result: CheckResult }[]): Promise<number> {
  if (entries.length === 0) return 0
  try {
    const res =
      service === "prime"
        ? await saveAlivePrimeCookies(entries)
        : service === "crunchyroll"
          ? await saveAliveCrunchyrollCookies(entries)
          : await saveAliveCookies(entries)
    return res.saved
  } catch {
    return 0
  }
}

async function runTelegramBulkCheck(chatId: string, userId: string, service: GeneratorService, uploads: { name: string; bytes: Uint8Array }[]): Promise<void> {
  const temporaryMessageIds: number[] = []
  const rememberTemporary = (ids: number[]) => {
    temporaryMessageIds.push(...ids)
  }
  const cleanupTemporaryMessages = async () => {
    // Delete only messages created by this run. Do not clear the shared menu or
    // interaction registries here: they can contain the final result document and
    // completion summary, which must remain available in Telegram.
    for (const messageId of new Set(temporaryMessageIds)) await deleteMessage(chatId, messageId)
  }
  // importCookieFiles already accepts multiple files and de-duplicates identical
  // cookie sets ACROSS all of them, so several uploads merge into one deduplicated
  // check exactly like dropping multiple files into the website checker at once.
  const imported = await importCookieFiles(
    uploads.map((upload) => new File([upload.bytes], upload.name, { type: "application/octet-stream" })),
    service,
  )
  const cookies = imported.sets
  if (cookies.length === 0) {
    await send(chatId, uploads.length > 1 ? "No cookie entries were found in those files." : "No cookie entries were found in that file.")
    return
  }
  if (uploads.length > 1) {
    rememberTemporary(await send(chatId, `Merged ${uploads.length} files into one batch: ${cookies.length} unique cookie entries after de-duplication.`))
  }

  await setTelegramCheckState(userId, "running")
  await setTelegramCheckActive(userId, true)
  try {
    rememberTemporary(await send(chatId, `Checking ${service} cookies…\nTotal: ${cookies.length}`, checkerControlKeyboard("running")))

    // Normalize every entry to the clean RAW `name=value; …` header the native
    // checker expects, regardless of the pasted/imported format (JSON, Netscape…).
    const headers = cookies.map((cookie) => prepareCookieForCheck(cookie, service).cookie || cookie)

    // Netflix/Prime/Crunchyroll must NEVER be dialed from the shared server IP —
    // exactly like the website bulk route. Source fresh, service-tested live proxies
    // and route every cookie through the same proxy-failover + dead-confirmation pool.
    rememberTemporary(await send(chatId, "Sourcing live proxies…"))
    const proxies = await getServerLiveProxies({ limit: 150 })
    if (proxies.length === 0) {
      await setTelegramCheckState(userId, "cancelled")
      await send(chatId, "No live proxies are available right now. Please try again shortly.")
      return
    }
    const checkViaProxy = createProxyPoolChecker(proxies, { service })

    const results: (CheckResult | undefined)[] = new Array(cookies.length)
    let completed = 0
    let cancelled = false
    // Running total of everything already persisted to the saved pool. Each alive
    // hit is saved the moment it's found (see the worker below) instead of waiting
    // for the whole batch to finish, so a /stop, crash, or timeout mid-run never
    // loses cookies that already passed the check.
    let savedSoFar = 0

    // Progress heartbeat: report every 30 seconds while checking.
    const progressTimer = setInterval(() => {
      void (async () => {
        const aliveSoFar = results.reduce((n, r) => (r && isAliveResult(r) ? n + 1 : n), 0)
        const state = await getTelegramCheckState(userId)
        rememberTemporary(await send(
          chatId,
          `Checking ${service} cookies…\nProgress: ${completed}/${cookies.length}\nAlive so far: ${aliveSoFar}`,
          checkerControlKeyboard(state),
        ))
      })()
    }, 30_000)

    const CONCURRENCY = 10
    let next = 0
    const worker = async (): Promise<void> => {
      while (true) {
        // Honor pause/cancel/restart between cookies.
        let state = await getTelegramCheckState(userId)
        while (state === "paused") {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          state = await getTelegramCheckState(userId)
        }
        if (state === "cancelled" || state === "restart") {
          cancelled = true
          return
        }
        const i = next++
        if (i >= headers.length) return
        const result = await checkViaProxy(headers[i], i)
        results[i] = result
        completed++
        // Save this exact hit to the pool immediately, using the original untrimmed
        // cookie text (never the check-optimized `headers[i]` slice) — same rule as
        // the end-of-run export below.
        if (isAliveResult(result)) {
          savedSoFar += await saveAliveForService(service, [{ cookie: cookies[i], result }])
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, headers.length) }, worker))
    } finally {
      clearInterval(progressTimer)
    }

    // Keep the ORIGINAL, full imported cookie set for storage/export (`cookies[i]`) —
    // never the check-optimized auth-only `headers[i]` slice. This is exactly how the
    // website persists and exports accounts: the full session (nfvdid, OptanonConsent,
    // etc.) is what a real login needs, and buildAccountDetails/cookieForStorage both
    // expect the untrimmed original text.
    const aliveEntries: { cookie: string; result: CheckResult }[] = []
    for (let i = 0; i < cookies.length; i++) {
      const result = results[i]
      if (result && isAliveResult(result)) aliveEntries.push({ cookie: cookies[i], result })
    }
    // Every alive hit was already persisted to the saved pool the instant it was
    // found (inside the worker above), so the running total IS the final count —
    // re-saving here would insert duplicates.
    const saved = savedSoFar

    if (cancelled) {
      await send(chatId, `Checker stopped.\nChecked: ${completed}/${cookies.length}\nAlive found: ${aliveEntries.length}\nSaved to pool: ${saved}`)
      return
    }

    const aliveCount = aliveEntries.length
    const errorCount = results.reduce((n, r) => (r && r.errorCategory ? n + 1 : n), 0)
    const deadCount = cookies.length - aliveCount - errorCount
  const serviceLabel = service === "crunchyroll" ? "Crunchyroll" : service === "prime" ? "Prime" : "Netflix"
  const date = new Date().toISOString().slice(0, 10)
  const fileName = `${serviceLabel}_${aliveCount}x_${date}_@cookiesmo_bot.txt`

    if (aliveCount > 0) {
      // Same rich per-account block the website's bulk checker exports: account
      // metadata + the browser-importable Cookie-Editor/Netscape session, one block
      // per alive account, separated by the same visual divider.
      const blocks = aliveEntries.map((entry, index) =>
        buildAccountDetails(entry.result, entry.cookie, { index: index + 1, total: aliveCount }, service),
      )
      const details = joinAccountDetails(blocks)
      await sendDocument(chatId, details, fileName)
    }

    await setTelegramCheckState(userId, "cancelled")
    await send(chatId, `${service} bulk check complete.\nTotal: ${cookies.length}\nAlive: ${aliveCount}\nDead: ${deadCount}\nErrors: ${errorCount}\nSaved to pool: ${saved}`)
  } finally {
    // Remove menus, progress updates, and temporary status messages after every
    // terminal outcome. The final document and summary are intentionally preserved.
    await cleanupTemporaryMessages()
    // Always clear "active" so /pause /resume /stop /cancel /restart become no-ops
    // again once this run has ended, whether it finished, was stopped, or errored.
    await setTelegramCheckActive(userId, false)
  }
}

async function sendDocument(chatId: string, content: string, fileName: string) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured")
  const form = new FormData()
  form.append("chat_id", chatId)
  form.append("document", new Blob([content], { type: "text/plain" }), fileName.replace(/\.json$/i, ".txt"))
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
    cache: "no-store",
  })
  if (!response.ok) throw new Error(`Telegram API sendDocument failed: ${response.status}`)
}

async function send(chatId: string, text: string, replyMarkup?: Record<string, unknown>, parseMode?: "HTML", disablePreview = false, preserve = false): Promise<number[]> {
  // Telegram rejects messages over 4,096 characters. Split long cookie exports
  // without truncating them; only the final chunk carries the keyboard.
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += MAX_MESSAGE) {
    chunks.push(text.slice(offset, offset + MAX_MESSAGE))
  }
  if (chunks.length === 0) chunks.push("")
  const messageIds: number[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const result = await telegram("sendMessage", {
      chat_id: chatId,
      text: chunks[index],
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(disablePreview ? { link_preview_options: { is_disabled: true } } : {}),
      ...(replyMarkup && index === chunks.length - 1 ? { reply_markup: replyMarkup } : {}),
    })
    if (typeof result?.message_id === "number") messageIds.push(result.message_id)
  }
  if (!preserve) for (const messageId of messageIds) await rememberInteraction(chatId, messageId)
  return messageIds
}

const serviceKeyboard = async () => ({
  inline_keyboard: [...await Promise.all(SERVICES.map(async (service) => {
    const options = await getPoolOptions(service.id)
    return [{ text: `${service.label} - ${options.total}`, callback_data: `generate:${service.id}` }]
  })), [{ text: "Back to Main Menu", callback_data: "command:start" }]],
})
const PLAN_PAGE_SIZE = 6
const netflixPlanKeyboard = (plans: Array<{ name: string; count: number }>, page = 0) => {
  const totalPages = Math.max(1, Math.ceil(plans.length / PLAN_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), totalPages - 1)
  const pagePlans = plans.slice(safePage * PLAN_PAGE_SIZE, (safePage + 1) * PLAN_PAGE_SIZE)
  const navigation: Array<{ text: string; callback_data: string }> = []
  if (safePage > 0) navigation.push({ text: "Previous", callback_data: `netflix-plans:${safePage - 1}` })
  if (safePage < totalPages - 1) navigation.push({ text: "Next", callback_data: `netflix-plans:${safePage + 1}` })
  return { inline_keyboard: [
    ...pagePlans.map(({ name, count }) => [{ text: `${name} - ${count}`, callback_data: `netflix-plan:${encodeURIComponent(name)}` }]),
    ...(navigation.length ? [navigation] : []),
    [{ text: "Back to Services", callback_data: "command:generate" }, { text: "Back to Main Menu", callback_data: "command:start" }],
  ] }
}
const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) || code
  } catch {
    return code
  }
}
  // Telegram supports large inline keyboards; 20 keeps each page within a practical message height.
  const COUNTRY_PAGE_SIZE = 20
  const netflixCountryKeyboard = (plan: string, countries: Array<{ code: string; count: number }>, page = 0) => {
  const totalPages = Math.max(1, Math.ceil(countries.length / COUNTRY_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), totalPages - 1)
  const pageCountries = countries.slice(safePage * COUNTRY_PAGE_SIZE, (safePage + 1) * COUNTRY_PAGE_SIZE)
  const navigation: Array<{ text: string; callback_data: string }> = []
  if (safePage > 0) navigation.push({ text: "Previous", callback_data: `netflix-country:${encodeURIComponent(plan)}:${safePage - 1}` })
  if (safePage < totalPages - 1) navigation.push({ text: "Next", callback_data: `netflix-country:${encodeURIComponent(plan)}:${safePage + 1}` })
  return {
  inline_keyboard: [
  ...pageCountries.map(({ code, count }) => [{ text: `${countryName(code)} - ${count}`, callback_data: `netflix-pick:${encodeURIComponent(plan)}:${encodeURIComponent(code)}` }]),
  ...(navigation.length ? [navigation] : []),
  [{ text: "Back to Plans", callback_data: "generate:netflix" }],
  ],
  }
  }
const unlockKeyboard = { inline_keyboard: [[{ text: "Unlock Free Access", callback_data: "unlock" }], [{ text: "Redeem Key", callback_data: "command:redeem" }, { text: "Back to Main Menu", callback_data: "command:start" }]] }
  // Bulk checker service picker, visible only via the admin-only "Bulk Checker" menu button.
  const bulkMenuKeyboard = { inline_keyboard: [
    [{ text: "Netflix", callback_data: "command:bulk_netflix" }],
    [{ text: "Prime Video", callback_data: "command:bulk_prime" }],
    [{ text: "Crunchyroll", callback_data: "command:bulk_crunchyroll" }],
    [{ text: "Back to Main Menu", callback_data: "command:start" }],
  ] }
  const startKeyboard = (locked: boolean, admin = false) => ({ inline_keyboard: [[{ text: locked ? "Unlock Free Access" : "Generate", callback_data: "command:generate" }], [{ text: "Redeem Key", callback_data: "command:redeem" }], [{ text: "Help", callback_data: "command:help" }], ...(admin ? [[{ text: "Bulk Checker", callback_data: "command:bulk_menu" }]] : [])] })
const helpKeyboard = { inline_keyboard: [[{ text: "How to Unlock Tutorial", url: "https://streamable.com/39mdk0" }], [{ text: "Back to Main Menu", callback_data: "command:start" }, { text: "Generate", callback_data: "command:generate" }], [{ text: "Redeem Key", callback_data: "command:redeem" }]] }
const redeemRetryKeyboard = { inline_keyboard: [[{ text: "Try Another Key", callback_data: "command:redeem" }], [{ text: "Back to Main Menu", callback_data: "command:start" }]] }
const deliveryKeyboard = { inline_keyboard: [[{ text: "Back to Main Menu", callback_data: "command:start" }, { text: "Generate", callback_data: "command:generate" }], [{ text: "Redeem Key", callback_data: "command:redeem" }]] }

async function rememberMenuMessages(chatId: string, messageIds: number[]): Promise<void> {
  if (!messageIds.length) return
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) await redis.set(`telegram:menus:${chatId}`, messageIds, { ex: 86400 })
}

async function clearMenuMessages(chatId: string): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return
  const ids = await redis.get<number[]>(`telegram:menus:${chatId}`)
  if (Array.isArray(ids)) for (const messageId of ids) await deleteMessage(chatId, messageId)
  await redis.del(`telegram:menus:${chatId}`)
}

async function rememberInteraction(chatId: string, messageId: unknown): Promise<void> {
  if (typeof messageId !== "number") return
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return
  const key = `telegram:interactions:${chatId}`
  const ids = (await redis.get<number[]>(key)) || []
  await redis.set(key, [...new Set([...ids, messageId])].slice(-100), { ex: 86400 })
}

async function clearInteractions(chatId: string): Promise<void> {
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (!redisEnabled) return
  const ids = await redis.get<number[]>(`telegram:interactions:${chatId}`)
  if (Array.isArray(ids)) for (const messageId of ids) await deleteMessage(chatId, messageId)
  await redis.del(`telegram:interactions:${chatId}`)
}

async function sendMenu(chatId: string, text: string, keyboard: Record<string, unknown>): Promise<void> {
  await clearMenuMessages(chatId)
  await clearInteractions(chatId)
  const ids = await send(chatId, text, keyboard, undefined, false, true)
  await rememberMenuMessages(chatId, ids)
}

async function claimStatus(userId: string, admin = false): Promise<string> {
  const publicLimits = await getClaimLimits()
  const userDeviceId = deviceId(userId)
  const pass = admin ? { valid: true, expiresAt: null, accessCodeId: undefined } : await getPass(userDeviceId)
  const activeCodeId = pass.valid && pass.accessCodeId ? pass.accessCodeId : undefined
  const lifetimeActive = Boolean(activeCodeId)
  const rows = await Promise.all(SERVICES.map(async ({ id: service, label }) => {
    const individualLimit = activeCodeId ? await getAccessCodeLimits(activeCodeId, service) : null
    const config = individualLimit ?? publicLimits[service]
    const allowance = admin ? null : await claimAllowance(
      service,
      "",
      deviceId(userId),
      undefined,
      individualLimit ? { ...individualLimit, scope: "lifetime" } : undefined,
    )
    return `${label}: ${admin ? 0 : config.limit - allowance!.remaining} / ${config.limit} per ${config.windowSeconds === 3600 ? "hour" : "day"}`
  }))
  const unlockedServices = admin || lifetimeActive ? SERVICES.map(() => true) : await Promise.all(SERVICES.map(({ id: service }) => hasTelegramDailyUnlock(userId)))
  const accessStatus = unlockedServices.every(Boolean) ? "Unlocked" : "Locked"
  const unlockExpiry = admin ? null : await telegramUnlockExpiresAt(userId)
  const timezone = process.env.TELEGRAM_APP_TIMEZONE || "Asia/Manila"
  const accessInfo = admin
    ? "Access: Admin mode"
    : lifetimeActive
      ? "Access: Lifetime key\nClaim limits reset automatically by service window"
      : unlockExpiry
        ? `Access: Free 24-hour pass\nExpires: ${unlockExpiry.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short" })}\nClaim limits reset by their hourly or daily window`
        : "Access required to generate accounts"
  return `Status: ${accessStatus}${lifetimeActive ? " (Lifetime)" : ""}\n${accessInfo}\n\nClaim usage (used / limit):\n${rows.join("\n")}`
}

export async function telegramWebhookSecret(): Promise<string> {
  const stored = await getTelegramWebhookSecret()
  return stored || process.env.TELEGRAM_WEBHOOK_SECRET || createHash("sha256").update(BOT_TOKEN || "disabled").digest("hex")
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message
  const callback = update.callback_query
  const chatId = id(message?.chat?.id) || id(callback?.message?.chat?.id)
  const userId = id(message?.from?.id) || id(callback?.from?.id)
  if (!chatId || !userId) return

  const actionLimit = await consumeTelegramAction(userId)
  if (!actionLimit.success) {
    if (callback?.id) await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Too many requests. Please try again shortly.", show_alert: true })
    else await send(chatId, "Too many requests. Please try again shortly.")
    return
  }
  if (callback?.id) await telegram("answerCallbackQuery", { callback_query_id: callback.id })
  if (!(await requireTelegramMembership(chatId, userId))) {
    if (callback?.message?.message_id) await deleteMessage(chatId, callback.message.message_id)
    return
  }
  await recordTelegramUser(userId)
  const rawMessage = typeof message?.text === "string" ? message.text.trim() : ""
  const messageToken = rawMessage.startsWith("/") ? rawMessage.split(/\s+/, 1)[0] : ""
  const redeemMatch = rawMessage.match(/^\/redeem(?:@[^\s]+)?(?:\s+(.+))?$/i)
  await clearInteractions(chatId)
  if (message?.message_id) await deleteMessage(chatId, message.message_id)
  const { redis, redisEnabled } = await import("@/lib/redis")
  const awaitingRedeem = redisEnabled && !rawMessage.startsWith("/") && await redis.get(`telegram:awaiting-redeem:${userId}`)
  const plainRedeemCode = typeof awaitingRedeem === "string" ? rawMessage : ""
  const looksLikeRedeemCode = /^(?:CML|CMF)-[A-Z0-9-]+$/i.test(rawMessage) ? rawMessage : ""
  const publicCommand = messageToken.match(/^\/(start|help|generate)(?:@[^\s]+)?/i)
  const callbackData = typeof callback?.data === "string" ? callback.data.trim() : ""
  const callbackCommand = callbackData.startsWith("command:") ? callbackData.slice(8) : null
  const normalizedCommand = publicCommand?.[1]?.toLowerCase()
  let raw = normalizedCommand ? `/${normalizedCommand}` : callbackCommand ? `/${callbackCommand}` : callbackData || messageToken || rawMessage
  if (callbackCommand) raw = `/${callbackCommand}`
  if (raw === "command:generate") raw = "/generate"
  if (raw === "command:start") raw = "/start"
  const adminPassword = adminCommand(raw)
  const adminLogout = /^\/(?:admin_)?logout$/i.test(raw)
  const resetCommand = raw.match(/^\/reset_(.+)$/i)
  const botOff = raw.match(/^\/botoff_(.+)$/i)
  const botOn = raw.match(/^\/boton_(.+)$/i)
  const statsCommand = raw.match(/^\/stats_(.+)$/i)
  if (statsCommand) {
    if ((await verifyPassword(statsCommand[1])) === "admin") {
      const stats = await getTelegramStats()
      await send(chatId, stats ? `Telegram Bot Stats\n\nUnique users: ${stats.users}\nSuccessful unlocks: ${stats.unlocks}\nSuccessful account generations: ${stats.generations}
Completions today: ${stats.today}` : "Telegram stats are unavailable because Redis is not configured.")
    }
    return
  }
  if (botOff || botOn) {
    const role = await verifyPassword((botOff || botOn)![1])
    if (role === "admin") {
      await setTelegramBotDisabled(Boolean(botOff))
      await send(chatId, botOff ? "Bot turned off." : "Bot turned on.")
    }
    return
  }
  if (await isTelegramBotDisabled()) {
    return
  }
  if (adminPassword !== null) {
    const role = await verifyPassword(adminPassword)
    if (role === "admin") {
      await setTelegramAdmin(userId)
      await send(chatId, "Ready.")
    }
    // Do not confirm or describe failed hidden commands.
    return
  }
  const admin = await isTelegramAdmin(userId)
  const documentFileId = typeof message?.document?.file_id === "string" ? message.document.file_id : null
  const documentFileName = typeof message?.document?.file_name === "string" ? message.document.file_name : "upload"
  if (admin && documentFileId) {
    const bulkService = await telegramBulkService(userId)
    if (!bulkService) {
      await send(chatId, "Choose a bulk checker first with /bulk_netflix, /bulk_prime, or /bulk_crunchyroll.")
      return
    }
    if (message?.message_id) await deleteMessage(chatId, message.message_id)
    // Queue this file into the shared batch. Sending several files back-to-back
    // (an album, or a few quick uploads) queues each one; only the FIRST call
    // becomes the batch owner and actually waits + runs the merged check, so
    // multiple files always collapse into a single deduplicated bulk run.
    const isOwner = await enqueueTelegramBulkFile(userId, { fileId: documentFileId, name: documentFileName })
    if (!isOwner) {
      await send(chatId, `Queued ${documentFileName} into the current batch.`)
      return
    }
    try {
      const entries = await drainTelegramBulkBatch(userId)
      const uploads = await Promise.all(entries.map((entry) => telegramFile(entry.fileId)))
      await runTelegramBulkCheck(chatId, userId, bulkService, uploads)
    } catch (error) {
      console.error("[telegram] bulk check failed", error)
      await send(chatId, `Bulk checker stopped without producing results.\nReason: ${error instanceof Error ? error.message : "Unknown checker error."}`)
    } finally {
      await redis.del(`telegram:bulk:service:${userId}`)
    }
    return
  }
  if (admin && /^\/(pause|resume|stop|cancel|restart)$/i.test(raw)) {
    // Controls only do something while a bulk check is actually running for this
    // admin — otherwise tapping a stale button or leftover command is a no-op.
    if (!(await isTelegramCheckActive(userId))) {
      await send(chatId, "No bulk check is currently running.")
      return
    }
    const command = raw.slice(1).toLowerCase() as TelegramCheckState | "stop" | "pause" | "resume" | "cancel"
    const state: TelegramCheckState = command === "pause" ? "paused" : command === "resume" ? "running" : command === "stop" || command === "cancel" ? "cancelled" : "restart"
    await setTelegramCheckState(userId, state)
    await send(chatId, state === "paused" ? "Checker paused. Tap Resume to continue." : state === "cancelled" ? "Checker stopped." : state === "restart" ? "Checker marked for restart; upload the file again to start a fresh run." : "Checker resumed.", state === "cancelled" || state === "restart" ? undefined : checkerControlKeyboard(state))
    return
  }
  if (admin && raw === "/bulk_menu") {
    await sendMenu(chatId, "Admin bulk checker. Choose a service, then upload a .txt, .zip, .rar, or supported archive. The bot scans every file and extracts all cookie formats, including multiple cookies in one text file.", bulkMenuKeyboard)
    return
  }
  if (admin && /^\/(bulk_(?:netflix|prime|crunchyroll))$/i.test(raw)) {
    const service = raw.match(/^\/bulk_(netflix|prime|crunchyroll)$/i)?.[1]?.toLowerCase() as GeneratorService
    await redis.set(`telegram:bulk:service:${userId}`, service, { ex: 900 })
    await send(chatId, `Admin ${service} bulk checker selected. Upload a .txt, .zip, .rar, or supported archive. The bot scans every file and extracts all cookie formats, including multiple cookies in one text file.`)
    return
  }
  if (admin && raw === "/bulk") {
    await sendMenu(chatId, "Admin bulk checker. Choose a service below.", bulkMenuKeyboard)
    return
  }
  if (adminLogout) {
    if (admin) {
      await clearTelegramAdmin(userId)
      await sendMenu(chatId, "Admin mode ended. You are now using normal user access.", unlockKeyboard)
    }
    return
  }
  if (resetCommand) {
    const role = await verifyPassword(resetCommand[1])
    if (role === "admin") {
      const device = deviceId(userId)
      const deleted = await resetTelegramUserAccess(userId)
      const unbound = await resetRedemptionForDevice(device)
      await send(chatId, `Your Telegram data has been reset. Cleared ${deleted} access and usage records and reset ${unbound} redeemed key. Other users and website accounts were not affected.`)
    }
    return
  }
  const access = await getTelegramAccessState(userId, admin)
  const lifetimeAccess = access.lifetime
  if (!admin && await resetExpiredTelegramLimits(userId)) {
    await sendMenu(chatId, "Your daily claim limits have just reset. Unlock 24-hour free access to generate accounts.", unlockKeyboard)
    return
  }

  if (plainRedeemCode || looksLikeRedeemCode || redeemMatch || raw === "/redeem" || raw === "redeem") {
    const code = plainRedeemCode || looksLikeRedeemCode || redeemMatch?.[1]?.trim()
    if (plainRedeemCode && redisEnabled) await redis.del(`telegram:awaiting-redeem:${userId}`)
    if (!code) {
      const { redis, redisEnabled } = await import("@/lib/redis")
      if (redisEnabled) await redis.set(`telegram:awaiting-redeem:${userId}`, "1", { ex: 600 })
      await sendMenu(chatId, "Send your access key as a message. No command is needed.", { inline_keyboard: [[{ text: "Cancel Redemption", callback_data: "command:start" }, { text: "Help", callback_data: "command:help" }]] })
      return
    }
    const currentPass = await getPass(deviceId(userId))
    if (currentPass.valid && currentPass.accessCodeId) {
      const activeCode = await getAccessCode(currentPass.accessCodeId)
      if (activeCode?.accessType === "temporary") {
        const requestedCode = await getAccessCodeByValue(code)
        if (requestedCode?.accessType === "temporary") {
          await sendMenu(chatId, "You already have an active 24-hour pass. Lifetime keys can still be redeemed.", startKeyboard(false, admin))
          return
        }
      }
    }
    const result = await redeemAccessCode(code, deviceId(userId))
    if (!result.ok) {
      await sendMenu(chatId, "This key could not be redeemed.\n\nPlease try another key.", redeemRetryKeyboard)
      return
    }
    if (result.accessType === "lifetime") {
      const { redis, redisEnabled } = await import("@/lib/redis")
      if (redisEnabled) await redis.set(`telegram:key-limits:${userId}`, { limits: result.limits, windows: result.windows }, { ex: 31536000 })
    }
    if (redisEnabled) await redis.del(`telegram:awaiting-redeem:${userId}`)
    const granted = result.accessType === "lifetime" ? await grantLifetimePass(deviceId(userId), result.codeId) : await grantPass(deviceId(userId), result.codeId)
    if (granted && result.accessType === "temporary") {
      await clearFreeClaimBuckets(deviceId(userId), SERVICES.map(({ id: service }) => service))
    }
    const limitText = result.accessType === "lifetime" ? `Limits: Netflix ${result.limits.netflix}/${result.windows.netflix}, Prime Video ${result.limits.prime}/${result.windows.prime}, Crunchyroll ${result.limits.crunchyroll}/${result.windows.crunchyroll}.` : "Limits: the system claim limits apply."
    await sendMenu(chatId, granted ? result.accessType === "lifetime" ? `Success. Lifetime access is now active.\n${limitText}` : `Success. 24-hour access is now active.\n${limitText}\nExpires in 24 hours.` : "We could not activate this key because access storage is unavailable. Please try again.", startKeyboard(granted ? false : true, admin))
    return
  }
  if (raw === "/logout") {
    await clearTelegramAdmin(userId)
    await send(chatId, "Admin mode disabled.")
    return
  }
  if (raw === "/start") {
    const locked = !access.valid
  await sendMenu(chatId, `Welcome to CookiesMo.\n\n${await claimStatus(userId, admin)}\n\nChoose an option below.`, startKeyboard(locked, admin))
  return
  }
  if (raw === "/status" || raw === "status") {
  const latest = await getTelegramAccessState(userId, admin)
  await sendMenu(chatId, `${await claimStatus(userId, admin)}\n\nChoose an option below.`, startKeyboard(!latest.valid, admin))
    return
  }
  if (raw === "/help") {
    await sendMenu(chatId, "How to use CookiesMo:\n\n1. Choose Generate to select a service and receive an account.\n2. Choose Unlock Free Access when access is locked.\n3. Choose Redeem Key, then send your key as a message without a command.\n4. Use Back to Main Menu to return to the main menu.", helpKeyboard)
    return
  }
  if (raw === "unlock") {
    const unlockUrl = await createTelegramUnlock(chatId, userId, "netflix")
    if (!unlockUrl) {
      await sendMenu(chatId, "Unlock access is temporarily unavailable. Please try again shortly.", unlockKeyboard)
      return
    }
    await sendMenu(chatId, "Complete the access step to unlock the bot for 24 hours.", { inline_keyboard: [[{ text: "Open Unlock Link", url: unlockUrl }], [{ text: "Back to Main Menu", callback_data: "command:start" }]] })
    return
  }
  const protectedAction = raw.startsWith("generate:") || raw.startsWith("netflix-plan:") || raw.startsWith("netflix-country:") || raw.startsWith("netflix-pick:")
  if (protectedAction && !(await getTelegramAccessState(userId, admin)).valid) {
    await sendMenu(chatId, "Access is locked. Unlock access for 24 hours to generate accounts.", unlockKeyboard)
    return
  }
  if (raw === "/generate" || raw === "generate") {
    const locked = !(await getTelegramAccessState(userId, admin)).valid
    if (locked) {
      await sendMenu(chatId, "Access is locked. Unlock access for 24 hours to generate accounts.", unlockKeyboard)
    } else {
      await sendMenu(chatId, `Choose a service to generate a live account:\n\n${await claimStatus(userId, admin)}`, await serviceKeyboard())
    }
    return
  }
  if (raw === "generate:netflix") {
    const summary = await getTelegramPoolSummary("netflix")
    await sendMenu(chatId, `Choose a Netflix plan:\n\nAvailable accounts: ${summary.total}`, netflixPlanKeyboard(summary.plans))
    return
  }
  if (raw.startsWith("netflix-plan:") || raw.startsWith("netflix-country:")) {
  const [, encodedPlan, encodedPage] = raw.split(":")
  const plan = decodeURIComponent(encodedPlan || "")
  const page = raw.startsWith("netflix-country:") ? Number.parseInt(encodedPage || "0", 10) : 0
  const summary = await getTelegramPoolSummary("netflix")
  const countries = summary.countries.filter((country) => country.plan === plan).map(({ code, count }) => ({ code, count }))
  const safePage = Number.isFinite(page) ? page : 0
  await sendMenu(chatId, `Choose a country for ${plan}:\n\nAvailable accounts: ${countries.reduce((sum, combo) => sum + combo.count, 0)}\nPage ${Math.min(Math.max(safePage, 0), Math.max(0, Math.ceil(countries.length / COUNTRY_PAGE_SIZE) - 1)) + 1} of ${Math.max(1, Math.ceil(countries.length / COUNTRY_PAGE_SIZE))}`, netflixCountryKeyboard(plan, countries, safePage))
  return
  }
  if (raw.startsWith("netflix-pick:")) {
    const [, encodedPlan, encodedCountry] = raw.split(":")
    const plan = decodeURIComponent(encodedPlan)
    const country = decodeURIComponent(encodedCountry)
    raw = `generate:netflix:${encodeURIComponent(plan)}:${encodeURIComponent(country)}`
  }
  if (raw.startsWith("generate:")) {
    if (!(await beginAction(userId))) {
      await send(chatId, "Your previous request is still processing. Please wait.")
      return
    }
    const progressIds = await send(chatId, "Checking live accounts…\nPlease wait.")
    try {
      const parts = raw.split(":")
      const service = serviceFrom(parts[1])
    if (!service || !SERVICES.some((item) => item.id === service)) {
      await deleteMessage(chatId, message?.message_id || callback?.message?.message_id)
      for (const progressId of progressIds) await deleteMessage(chatId, progressId)
      await endAction(userId)
      await send(chatId, "That service is not available.")
      return
    }
    const generatorService = service as GeneratorService
    const admin = await isTelegramAdmin(userId)
    const callbackAccess = await getTelegramAccessState(userId, admin)
    if (!callbackAccess.valid) {
      const unlockUrl = await createTelegramUnlock(chatId, userId, generatorService)
      if (!unlockUrl) {
        await sendMenu(chatId, "Free access is temporarily unavailable. Please refresh your status or try again later.", unlockKeyboard)
        return
      }
      await send(chatId, "Complete today’s access to access the bot for 24 hours.\nOpen the link or copy then paste it to your browser:", { inline_keyboard: [[{ text: "Unlock Free Access", url: unlockUrl }], [{ text: "Refresh Status", callback_data: "command:status" }, { text: "Back to Main Menu", callback_data: "command:start" }]] })
      return
    }
    const telegramPass = await getPass(deviceId(userId))
    const latestAccess = await getTelegramAccessState(userId, admin)
    if (!latestAccess.valid) {
      await endAction(userId)
      await sendMenu(chatId, "Your 24-hour access has expired. Unlock access again to generate accounts.", unlockKeyboard)
      return
    }
    const lifetimeOverride = !admin && telegramPass.accessCodeId
      ? await getAccessCodeLimits(telegramPass.accessCodeId, generatorService)
      : null
    const allowance = admin ? null : await claimAllowance(
      generatorService,
      "",
      deviceId(userId),
      undefined,
      lifetimeOverride ? { ...lifetimeOverride, scope: "lifetime" } : undefined,
    )
    if (allowance && !allowance.allowed) {
      await deleteMessage(chatId, message?.message_id || callback?.message?.message_id)
      for (const progressId of progressIds) await deleteMessage(chatId, progressId)
      await endAction(userId)
      await sendMenu(chatId, `Limit reached: ${allowance.label}. Try again after the window resets.`, deliveryKeyboard)
      return
    }
    const selectedPlan = generatorService === "netflix" && parts[2] ? decodeURIComponent(parts[2]) : null
    const selectedCountry = generatorService === "netflix" && parts[3] ? decodeURIComponent(parts[3]) : null
    const receivedIds: string[] = []
    let account: Awaited<ReturnType<typeof distributeAccount>> = null
    let granted: Awaited<ReturnType<typeof toGrantedAccount>> | null = null
    const attempts = generatorService === "netflix" ? 24 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      account = await distributeAccount({ service: generatorService, plan: selectedPlan, country: selectedCountry, receivedIds })
      if (!account) break
      receivedIds.push(account.id)
      const candidate = await toGrantedAccount(account, generatorService, { freshLinks: true })
      if (generatorService !== "netflix") { granted = candidate; break }
      const links = candidate.result.links
      const hasValidLink = [links?.pc, links?.mobile, links?.tv].some((link) => typeof link === "string" && /^https?:\/\//i.test(link))
      if (hasValidLink) { granted = candidate; break }
    }
    if (!account || !granted) {
      await deleteMessage(chatId, message?.message_id || callback?.message?.message_id)
      for (const progressId of progressIds) await deleteMessage(chatId, progressId)
      await endAction(userId)
      await sendMenu(chatId, "Claim failed. No account with a usable link is currently available. Your claim limit was not affected. You can retry, refresh your status, or return to the main menu.", deliveryKeyboard)
      return
    }
    const serviceLabel = SERVICES.find((item) => item.id === service)?.label || service
    const serviceDomain = service === "netflix" ? "https://www.netflix.com" : service === "prime" ? "https://www.primevideo.com" : "https://www.crunchyroll.com"
    const details = `Service: <a href="${serviceDomain}">${serviceLabel}</a>\nPlan: ${escapeHtml(granted.result.plan || "Not available")}`
    if (service === "netflix") {
      const links = granted.result.links
      const profiles = granted.result.profiles?.filter(Boolean) || []
      const profileText = profiles.length ? profiles.map((profile) => escapeHtml(profile)).join(", ") : "Not available"
      const linkRow = (label: string, url?: string) => url ? [
        { text: `Open ${label} link`, url },
      ] : []
      const linkRows = [linkRow("PC", links?.pc), linkRow("Mobile", links?.mobile), linkRow("TV", links?.tv)].filter((row) => row.length > 0)
      const spoilerLinks = [
        links?.pc ? `PC: <tg-spoiler>${escapeHtml(links.pc)}</tg-spoiler>` : null,
        links?.mobile ? `Mobile: <tg-spoiler>${escapeHtml(links.mobile)}</tg-spoiler>` : null,
        links?.tv ? `TV: <tg-spoiler>${escapeHtml(links.tv)}</tg-spoiler>` : null,
      ].filter(Boolean).join("\n\n")
      try {
        await send(chatId, `${details}\nProfiles: ${profileText}\n\nDirect Auth Links:\n${spoilerLinks}`, {
          inline_keyboard: linkRows,
        }, "HTML", true, true)
      } catch (deliveryError) {
        console.error("[telegram] Netflix rich message failed", deliveryError)
        await send(chatId, `${serviceLabel}\nPlan: ${granted.result.plan || "Not available"}\nProfiles: ${profiles.length ? profiles.map((profile) => profile).join(", ") : "Not available"}\n\nDirect Auth Links:\n${spoilerLinks}`, undefined, undefined, true, true)
        for (const [label, link] of [["PC", links?.pc], ["Mobile", links?.mobile], ["TV", links?.tv]] as const) {
          if (link) await send(chatId, label, { inline_keyboard: [linkRow(label, link)] }, undefined, false, true)
        }
      }
    } else {
      const exportService = service === "prime" ? "prime" : "crunchyroll"
      const copyValue = service === "prime"
        ? cookieToNetscape(granted.cookie, "prime")
        : cookieToCookieEditorJson(granted.cookie, exportService)
      await send(chatId, details, undefined, "HTML", false, true)
      await sendDocument(chatId, copyValue, `${service}-cookies.${service === "prime" ? "txt" : "json"}`)
    }
    await deleteMessage(chatId, message?.message_id || callback?.message?.message_id)
    for (const progressId of progressIds) await deleteMessage(chatId, progressId)
    await incrementTelegramStat("generations")
    await recordClaim(
      generatorService,
      "",
      deviceId(userId),
      undefined,
      lifetimeOverride ? { ...lifetimeOverride, scope: "lifetime" } : undefined,
    )
    await sendMenu(chatId, `${serviceLabel} account delivered successfully.`, deliveryKeyboard)
    return
    } catch (error) {
      console.error("[telegram] generation failed", error)
      await sendMenu(chatId, "We couldn’t complete that request. No claim was recorded. Please retry, refresh your status, or return to the main menu.", deliveryKeyboard).catch(() => undefined)
    } finally {
      await deleteMessage(chatId, message?.message_id || callback?.message?.message_id)
      for (const progressId of progressIds) await deleteMessage(chatId, progressId)
      await endAction(userId)
    }
  }
  const locked = !access.valid
  await sendMenu(chatId, `Welcome to CookiesMo.\n\n${await claimStatus(userId, admin)}\n\nChoose an option below.`, startKeyboard(locked, admin))
}

export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const updateId = id(update.update_id)
  if (!updateId) return handleTelegramUpdate(update)
  const { redis, redisEnabled } = await import("@/lib/redis")
  if (redisEnabled) {
    const key = `telegram:update:${updateId}`
    const claimed = await redis.set(key, "1", { nx: true, ex: 86400 })
    if (!claimed) return
  }
  await handleTelegramUpdate(update)
}
