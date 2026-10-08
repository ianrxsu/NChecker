import { NextRequest, NextResponse } from "next/server"
import { isAdminAuthenticated } from "@/lib/admin-auth"
import { createAccessCode, listAccessCodes, updateAccessCode } from "@/lib/access-codes"

export const dynamic = "force-dynamic"

async function authorized() {
  return isAdminAuthenticated()
}

export async function GET() {
  if (!(await authorized())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try { return NextResponse.json(await listAccessCodes()) } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load access codes" }, { status: 500 }) }
}

export async function POST(req: NextRequest) {
  if (!(await authorized())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await req.json()
    if (!body || typeof body.code !== "string") return NextResponse.json({ error: "The access code must be text." }, { status: 400 })
    return NextResponse.json(await createAccessCode(body.code, body.limits ?? {}, body.windows ?? {}, body.accessType === "temporary" ? "temporary" : "lifetime"), { status: 201 })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create code" }, { status: 400 }) }
}

export async function PATCH(req: NextRequest) {
  if (!(await authorized())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const body = await req.json()
    const id = Number(body?.id)
    const action = body?.action
    const actions = ["revoke", "activate", "unbind", "delete", "limits"] as const
    if (!Number.isSafeInteger(id) || id < 1 || !actions.includes(action)) return NextResponse.json({ error: "Invalid request: id and action are required." }, { status: 400 })
    if (action === "limits" && (!body.limits || typeof body.limits !== "object")) return NextResponse.json({ error: "Limits are required." }, { status: 400 })
    await updateAccessCode(id, action, body.limits, body.windows)
    return NextResponse.json({ ok: true })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update access code" }, { status: 400 }) }
}
