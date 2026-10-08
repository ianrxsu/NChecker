import JSZip from "jszip"
import { gunzipSync, strFromU8 } from "fflate"
import { extractCookieSets, extractAllCookieBlocks } from "@/lib/cookie-utils"

export type ImportResult = {
  sets: string[]
  fileCount: number
  skipped: string[]
}

// Text-like extensions we will read directly and scan for cookie sets. Broadened
// well beyond the original set to cover the many shapes cookie dumps arrive in
// (CSV/TSV exports, logs, HAR captures, JSON lines, env/conf dumps, etc.).
const TEXT_EXT = /\.(txt|text|md|json|ndjson|jsonl|csv|tsv|log|out|cookies?|netscape|headers?|har|dat|conf|cfg|ini|env|nfo)$/i
// Zip-family archives JSZip can open. Many formats are just renamed zips, so we
// accept the common ones rather than only `.zip`.
const ZIP_EXT = /\.(zip|zipx|cbz|jar|xpi|epub|nfg)$/i
// Single-file gzip (e.g. cookies.txt.gz, dump.tar.gz). We gunzip then scan the
// decompressed text — for tar.gz this still works because tar payloads are mostly
// plaintext and extractCookieSets finds the cookie blocks regardless of headers.
const GZIP_EXT = /\.(gz|gzip|tgz)$/i
// RAR archives are expanded in the browser via node-unrar-js (an emscripten WASM
// module that runs client-side when handed the wasm binary directly) — scanning
// every entry in every folder, including nested archives. No upload, so no body limit.
const RAR_EXT = /\.rar$/i
// High safety ceiling only to avoid crashing the browser tab — not a cookie-count limit.
const MAX_TOTAL_BYTES = 500_000_000

// Decides whether a zip ENTRY is worth scanning as text: known text extensions,
// or extension-less names (cookie dumps inside archives are often bare files).
function isScannableEntry(name: string): boolean {
  const base = name.split("/").pop() ?? name
  return TEXT_EXT.test(base) || !base.includes(".")
}

// How deep we follow archives nested inside archives (rar→zip→…), matching the
// old server route. Bounded to avoid zip-bomb-style infinite nesting.
const MAX_NEST_DEPTH = 3

// Copy a view into a standalone ArrayBuffer (node-unrar-js requires a plain
// ArrayBuffer, not the ArrayBuffer|SharedArrayBuffer union Uint8Array exposes).
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength)
  new Uint8Array(out).set(u8)
  return out
}

type Unrar = {
  createExtractorFromData: (typeof import("node-unrar-js"))["createExtractorFromData"]
  wasmBinary: ArrayBuffer
}

// Lazily load the RAR engine IN THE BROWSER. node-unrar-js is an emscripten WASM
// module that runs client-side as long as we hand it the wasm binary explicitly
// (so it never tries to fetch/locate it itself). The wasm is served from /public.
// Cached so repeated RAR files don't refetch. Extracting in the browser is what
// removes the 4.5 MB serverless request-body limit that caused 413 "Content Too
// Large" when big archives were uploaded to /api/extract-archive.
let unrarCache: Promise<Unrar> | null = null
function loadUnrar(): Promise<Unrar> {
  if (!unrarCache) {
    unrarCache = (async () => {
      const [mod, wasmBinary] = await Promise.all([
        import("node-unrar-js"),
        fetch("/unrar.wasm").then((r) => {
          if (!r.ok) throw new Error("failed to load unrar.wasm")
          return r.arrayBuffer()
        }),
      ])
      return { createExtractorFromData: mod.createExtractorFromData, wasmBinary }
    })().catch((e) => {
      unrarCache = null // allow a retry on a later file
      throw e
    })
  }
  return unrarCache
}

// Recursively expands one archive's bytes in the browser, scanning EVERY entry in
// EVERY folder and descending into nested rar/zip/gz up to MAX_NEST_DEPTH.
async function scanArchiveBytes(
  name: string,
  bytes: Uint8Array,
  depth: number,
  scan: (text: string) => string[],
  unrar: Unrar,
  out: string[],
): Promise<void> {
  if (depth > MAX_NEST_DEPTH) return
  if (RAR_EXT.test(name)) {
    const extractor = await unrar.createExtractorFromData({
      data: toArrayBuffer(bytes),
      wasmBinary: unrar.wasmBinary,
    })
    // No `files` filter → extract everything, at every folder depth. `files` is a
    // lazy generator; spread it once so iteration is fully materialized.
    const files = [...extractor.extract({}).files]
    for (const f of files) {
      if (f.fileHeader.flags.directory || !f.extraction) continue
      await scanEntryBytes(f.fileHeader.name, f.extraction, depth, scan, unrar, out)
    }
  } else if (ZIP_EXT.test(name)) {
    const zip = await JSZip.loadAsync(bytes)
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue
      await scanEntryBytes(entry.name, await entry.async("uint8array"), depth, scan, unrar, out)
    }
  } else if (GZIP_EXT.test(name)) {
    await scanEntryBytes(name.replace(GZIP_EXT, ""), gunzipSync(bytes), depth, scan, unrar, out)
  } else {
    out.push(...scan(strFromU8(bytes)))
  }
}

// One extracted entry: descend if it's another archive, else scan it as text.
async function scanEntryBytes(
  name: string,
  content: Uint8Array,
  depth: number,
  scan: (text: string) => string[],
  unrar: Unrar,
  out: string[],
): Promise<void> {
  if (RAR_EXT.test(name) || ZIP_EXT.test(name) || GZIP_EXT.test(name)) {
    await scanArchiveBytes(name, content, depth + 1, scan, unrar, out)
  } else if (isScannableEntry(name)) {
    out.push(...scan(strFromU8(content)))
  }
}

// Reads a list of uploaded files (plain text, JSON, CSV/logs, .zip-family archives,
// or .gz archives) and returns every cookie set found inside them. Archives are
// auto-expanded and only text-like entries are scanned — everything else is skipped.
export async function importCookieFiles(
  files: File[],
  service: "netflix" | "prime" | "crunchyroll" | "steam" | "spotify" | "any" | "all" = "any",
): Promise<ImportResult> {
  const sets: string[] = []
  const skipped: string[] = []
  let fileCount = 0
  let totalBytes = 0

  // "all" is the EXTRACTOR mode: keep every cookie for every domain (no auth gate,
  // no service restriction). Every other value routes through the checker-oriented
  // extractCookieSets, which only keeps Netflix/Prime/Crunchyroll account sets.
  const scan = (text: string): string[] =>
    service === "all" ? extractAllCookieBlocks(text) : extractCookieSets(text, service)

  for (const file of files) {
    totalBytes += file.size
    if (totalBytes > MAX_TOTAL_BYTES) {
      skipped.push(`${file.name} (size limit reached)`)
      continue
    }

    try {
      if (RAR_EXT.test(file.name) || file.type.includes("rar")) {
        // Extract RAR ENTIRELY in the browser (no upload), so there's no 4.5 MB
        // serverless body limit — large archives no longer 413. Expands every folder
        // and any nested archives, scanning each entry for cookie sets.
        const unrar = await loadUnrar()
        const found: string[] = []
        await scanArchiveBytes(file.name, new Uint8Array(await file.arrayBuffer()), 0, scan, unrar, found)
        if (found.length) {
          sets.push(...found)
          fileCount++
        } else {
          skipped.push(`${file.name} (no cookies inside)`)
        }
      } else if (ZIP_EXT.test(file.name) || file.type.includes("zip")) {
        const zip = await JSZip.loadAsync(await file.arrayBuffer())
        const entries = Object.values(zip.files).filter((e) => !e.dir && isScannableEntry(e.name))
        if (entries.length === 0) skipped.push(`${file.name} (no text files inside)`)
        for (const entry of entries) {
          const text = await entry.async("string")
          const found = scan(text)
          if (found.length) {
            sets.push(...found)
            fileCount++
          } else {
            skipped.push(entry.name)
          }
        }
      } else if (GZIP_EXT.test(file.name) || file.type.includes("gzip")) {
        const text = strFromU8(gunzipSync(new Uint8Array(await file.arrayBuffer())))
        const found = scan(text)
        if (found.length) {
          sets.push(...found)
          fileCount++
        } else {
          skipped.push(`${file.name} (no cookies inside)`)
        }
      } else if (TEXT_EXT.test(file.name) || file.type.startsWith("text/") || file.type.includes("json")) {
        const text = await file.text()
        const found = scan(text)
        if (found.length) {
          sets.push(...found)
          fileCount++
        } else {
          skipped.push(file.name)
        }
      } else {
        // Last resort: try reading anything else as text — small unknown files may
        // still be plaintext cookie dumps with an odd extension.
        if (file.size <= 5_000_000) {
          const text = await file.text()
          const found = scan(text)
          if (found.length) {
            sets.push(...found)
            fileCount++
          } else {
            skipped.push(`${file.name} (unsupported type)`)
          }
        } else {
          skipped.push(`${file.name} (unsupported type)`)
        }
      }
    } catch {
      skipped.push(`${file.name} (failed to read)`)
    }
  }

  // De-duplicate identical cookie sets so the same account isn't checked twice.
  const seen = new Set<string>()
  const unique = sets.filter((s) => {
    const key = s.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return { sets: unique, fileCount, skipped }
}
