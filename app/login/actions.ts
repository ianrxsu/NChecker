"use server"

import { createHmac, timingSafeEqual } from "crypto"
import { LOCAL_COOKIE } from "@/lib/local-generator-auth"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

function signature(): string {
  return createHmac("sha256", process.env.GENERATOR_SECRET_CODE || "missing-generator-secret")
    .update("local-generator-session")
    .digest("base64url")
}

function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : ""
  return next.startsWith("/") && !next.startsWith("//") ? next : "/account-generator"
}

export async function signInWithGeneratorCode(formData: FormData) {
  const next = safeNext(formData.get("next"))
  const submitted = formData.get("generatorCode")
  const expected = process.env.GENERATOR_SECRET_CODE
  const submittedBuffer = Buffer.from(typeof submitted === "string" ? submitted : "")
  const expectedBuffer = Buffer.from(expected || "")
  const valid = Boolean(expected) && submittedBuffer.length === expectedBuffer.length && timingSafeEqual(submittedBuffer, expectedBuffer)

  if (!valid) redirect(`/login?error=${encodeURIComponent("Invalid generator code")}&next=${encodeURIComponent(next)}`)

  const store = await cookies()
  store.set(LOCAL_COOKIE, `1.${signature()}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  })
  redirect(next)
}

