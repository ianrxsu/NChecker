"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { DatabaseBackup, Download, Upload, HardDriveDownload, Loader2, FileJson } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useConfirm } from "@/components/ui/confirm-dialog"

type StoreSelection = { neon: boolean; redis: boolean }

type ImportSummary = {
  neon: { restored: boolean; tables: number; rows: number }
  redis: { restored: boolean; keys: number }
  errors: string[]
}

type RedisEntry = { key: string; type: string; ttl: number; value: unknown }
type BackupDoc = {
  format?: string
  createdAt?: string
  stores?: {
    neon?: { enabled?: boolean; tables?: Record<string, Record<string, unknown>[]> }
    redis?: { enabled?: boolean; available?: boolean; error?: string; keys?: RedisEntry[] }
  }
  warnings?: string[]
}

// Keep each request comfortably under the serverless body limit (~4.5MB on Vercel).
const MAX_CHUNK_BYTES = 2_000_000

async function postAction(payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetch("/api/admin/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  return data as Record<string, unknown>
}

// Splits an array into batches whose serialized size stays under MAX_CHUNK_BYTES
// (each item also travels alone if it individually exceeds the ceiling).
function* batchBySize<T>(items: T[]): Generator<T[]> {
  let batch: T[] = []
  let size = 0
  for (const item of items) {
    const itemSize = JSON.stringify(item).length
    if (batch.length && size + itemSize > MAX_CHUNK_BYTES) {
      yield batch
      batch = []
      size = 0
    }
    batch.push(item)
    size += itemSize
  }
  if (batch.length) yield batch
}

// Streams a restore to the server in small chunks and returns an aggregate summary.
async function runChunkedRestore(
  doc: BackupDoc,
  selection: StoreSelection,
  onProgress: (msg: string) => void,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    neon: { restored: false, tables: 0, rows: 0 },
    redis: { restored: false, keys: 0 },
    errors: [],
  }

  // ── Neon ──────────────────────────────────────────────────────────────────
  if (selection.neon && doc.stores?.neon?.enabled) {
    const tablesMap = doc.stores.neon.tables ?? {}
    const tableNames = Object.keys(tablesMap)

    onProgress("Clearing Neon tables…")
    await postAction({ action: "neon-begin", tables: tableNames })

    let tableCount = 0
    let rowCount = 0
    for (const table of tableNames) {
      const rows = tablesMap[table] ?? []
      try {
        let inserted = 0
        for (const batch of batchBySize(rows)) {
          const res = await postAction({ action: "neon-insert", table, rows: batch })
          inserted += (res.rows as number) ?? 0
          rowCount += (res.rows as number) ?? 0
          onProgress(`Neon: "${table}" — ${inserted}/${rows.length} rows`)
        }
        tableCount += 1
      } catch (err) {
        summary.errors.push(`Neon table "${table}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    onProgress("Finalizing Neon sequences…")
    try {
      await postAction({ action: "neon-finalize", tables: tableNames })
    } catch (err) {
      summary.errors.push(`Neon finalize: ${err instanceof Error ? err.message : String(err)}`)
    }
    summary.neon = { restored: true, tables: tableCount, rows: rowCount }
  }

  // ── Redis ─────────────────────────────────────────────────────────────────
  if (selection.redis && doc.stores?.redis?.enabled && doc.stores.redis.available !== false) {
    const entries = doc.stores.redis.keys ?? []
    onProgress("Clearing existing Redis keys…")
    await postAction({ action: "redis-begin" })
    let keyCount = 0
    let done = 0
    for (const batch of batchBySize(entries)) {
      const res = await postAction({ action: "redis-chunk", entries: batch })
      keyCount += (res.keys as number) ?? 0
      const errs = res.errors as string[] | undefined
      if (errs?.length) summary.errors.push(...errs)
      done += batch.length
      onProgress(`Redis: ${done}/${entries.length} keys`)
    }
    summary.redis = { restored: true, keys: keyCount }
  } else if (selection.redis && doc.stores?.redis?.enabled && doc.stores.redis.available === false) {
    summary.errors.push(doc.stores.redis.error || "Redis was unavailable when this backup was created; Neon was restored independently.")
  }

  return summary
}

// A small toggle chip for choosing which stores an action targets.
function StoreToggle({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string
  active: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={
        "rounded-md border px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (active
          ? "border-foreground bg-primary text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:border-foreground hover:text-foreground")
      }
    >
      {label}
    </button>
  )
}

// Full-system backup & restore. Exports every Neon table and every Redis key into
// one portable JSON file, and restores from such a file. Restore REPLACES the data
// in the selected stores, so it is gated behind an explicit confirm.
export function BackupCard() {
  const confirm = useConfirm()
  const fileInput = useRef<HTMLInputElement>(null)

  const [exportSel, setExportSel] = useState<StoreSelection>({ neon: true, redis: true })
  const [importSel, setImportSel] = useState<StoreSelection>({ neon: true, redis: true })
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState("")
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  async function handleExport() {
    if (!exportSel.neon && !exportSel.redis) {
      toast.info("Select at least one store to export.")
      return
    }
    setExporting(true)
    try {
      // A backup must always contain the complete system snapshot.
      const params = new URLSearchParams({ neon: "1", redis: "1" })
      const res = await fetch(`/api/admin/backup?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
      const a = document.createElement("a")
      a.href = url
      a.download = `backup-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success("Backup exported", { description: "The full backup file was downloaded." })
    } catch (err) {
      toast.error("Could not export backup", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setExporting(false)
    }
  }

  function pickFile() {
    setSummary(null)
    fileInput.current?.click()
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Reset the input so selecting the same file again re-triggers change.
    e.target.value = ""
    if (!file) return

    if (!importSel.neon && !importSel.redis) {
      toast.info("Select at least one store to restore into.")
      return
    }

    let backup: unknown
    try {
      backup = JSON.parse(await file.text())
    } catch {
      toast.error("Invalid file", { description: "That file is not valid JSON." })
      return
    }

    const doc = backup as { format?: string; version?: number; createdAt?: string; counts?: Record<string, unknown>; warnings?: string[] }
    if (doc?.format !== "cookie-checker-backup" || doc?.version !== 1) {
      toast.error("Invalid backup", { description: "This file is not a compatible Cookie Checker backup." })
      return
    }
    const warnings = Array.isArray(doc.warnings) ? doc.warnings : []
    if (warnings.length) {
      toast.warning("Backup contains warnings", { description: warnings.join(" ") })
    }

    const targets = [importSel.neon && "Neon (Postgres)", importSel.redis && "Redis"].filter(Boolean).join(" + ")
    const ok = await confirm({
      title: "Restore from backup?",
      description: `This will REPLACE all current data in ${targets} with the contents of "${file.name}"${
        doc.createdAt ? ` (created ${new Date(doc.createdAt).toLocaleString()})` : ""
      }. This cannot be undone.`,
      confirmLabel: "Restore & replace",
      destructive: true,
    })
    if (!ok) return

    setImporting(true)
    setSummary(null)
    setProgress("Starting…")
    try {
      const s = await runChunkedRestore(backup as BackupDoc, importSel, setProgress)
      setSummary(s)
      const parts: string[] = []
      if (s.neon.restored) parts.push(`${s.neon.tables} tables / ${s.neon.rows} rows`)
      if (s.redis.restored) parts.push(`${s.redis.keys} Redis keys`)
      toast.success("Backup restored", {
        description: parts.length ? `Restored ${parts.join(" and ")}.` : "Nothing to restore.",
      })
    } catch (err) {
      toast.error("Could not restore backup", {
        description: err instanceof Error ? err.message : "Unknown error",
      })
    } finally {
      setImporting(false)
      setProgress("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <DatabaseBackup className="size-4 text-muted-foreground" aria-hidden />
          Data backup &amp; restore
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Export a single portable JSON file containing <span className="font-semibold text-foreground">all system data</span>{" "}
          — every Neon (Postgres) table (saved cookies, metrics, claims, reward sessions) and every Upstash Redis key
          (config flags, counters, proxies). Import restores that file into this environment.
        </p>

        {/* Export */}
        <div className="rounded-md glass p-4">
          <div className="flex items-center gap-2">
            <Download className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-semibold text-foreground">Export backup</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Downloads a complete snapshot as a JSON file.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Includes:</span>
            <span className="rounded-md border border-foreground bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-primary-foreground">All Neon tables</span>
            <span className="rounded-md border border-foreground bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-primary-foreground">All Redis keys</span>
            <Button size="sm" className="ml-auto" onClick={handleExport} disabled={exporting}>
              {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
              {exporting ? "Exporting…" : "Download backup"}
            </Button>
          </div>
        </div>

        <Separator />

        {/* Import */}
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2">
            <Upload className="size-4 text-destructive" aria-hidden />
            <span className="text-sm font-semibold text-foreground">Restore from backup</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Replaces existing data in the selected stores with the file&apos;s contents. This cannot be undone.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Restore:</span>
            <StoreToggle
              label="Neon"
              active={importSel.neon}
              onClick={() => setImportSel((s) => ({ ...s, neon: !s.neon }))}
            />
            <StoreToggle
              label="Redis"
              active={importSel.redis}
              onClick={() => setImportSel((s) => ({ ...s, redis: !s.redis }))}
            />
            <Button
              size="sm"
              variant="destructive"
              className="ml-auto"
              onClick={pickFile}
              disabled={importing}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <HardDriveDownload className="size-4" aria-hidden />
              )}
              {importing ? "Restoring…" : "Choose file & restore"}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleFileSelected}
            />
          </div>

          {importing && progress && (
            <p className="mt-3 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {progress}
            </p>
          )}

          {summary && (
            <div className="mt-4 space-y-1.5 rounded-md border border-border bg-card p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold text-foreground">
                <FileJson className="size-3.5 text-muted-foreground" aria-hidden />
                Restore summary
              </div>
              {summary.neon.restored && (
                <p className="text-muted-foreground">
                  Neon: <span className="font-mono text-foreground">{summary.neon.tables}</span> tables,{" "}
                  <span className="font-mono text-foreground">{summary.neon.rows}</span> rows
                </p>
              )}
              {summary.redis.restored && (
                <p className="text-muted-foreground">
                  Redis: <span className="font-mono text-foreground">{summary.redis.keys}</span> keys
                </p>
              )}
              {summary.errors.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  <p className="font-semibold text-destructive">{summary.errors.length} warning(s):</p>
                  {summary.errors.slice(0, 6).map((err, i) => (
                    <p key={i} className="break-words font-mono text-[11px] text-destructive/80">
                      {err}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
