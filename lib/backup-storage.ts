import { exportBackup, type BackupDocument } from "@/lib/backup"

const bucket = "database-backups"
const storageBase = () => `${process.env.SUPABASE_URL}/storage/v1`
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY

function headers() {
  const key = serviceKey()
  if (!key) throw new Error("Supabase service key is not configured.")
  return { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" }
}

async function ensureBucket() {
  const response = await fetch(`${storageBase()}/bucket`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    cache: "no-store",
  })
  if (!response.ok && response.status !== 409) throw new Error(`Could not create backup bucket (${response.status}).`)
}

export async function createRollingBackup(): Promise<{ path: string; counts: BackupDocument["counts"] }> {
  const document = await exportBackup({ neon: true, redis: true })
  await ensureBucket()
  const path = `snapshot-${Date.now()}.json`
  const upload = await fetch(`${storageBase()}/object/${bucket}/${path}`, {
    method: "POST",
    headers: { ...headers(), "x-upsert": "true" },
    body: JSON.stringify(document),
    cache: "no-store",
  })
  if (!upload.ok) throw new Error(`Backup upload failed (${upload.status}).`)

  const list = await fetch(`${storageBase()}/object/list/${bucket}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ prefix: "snapshot-", limit: 1000, sortBy: { column: "created_at", order: "desc" } }),
    cache: "no-store",
  })
  if (!list.ok) throw new Error(`Backup listing failed (${list.status}).`)
  const objects = (await list.json()) as Array<{ name: string }>
  const oldPaths = objects.filter((object) => object.name !== path).map((object) => object.name)
  if (oldPaths.length) {
    const remove = await fetch(`${storageBase()}/object/${bucket}`, {
      method: "DELETE",
      headers: headers(),
      body: JSON.stringify({ prefixes: oldPaths }),
      cache: "no-store",
    })
    if (!remove.ok) throw new Error(`Old backup cleanup failed (${remove.status}).`)
  }
  return { path, counts: document.counts }
}
