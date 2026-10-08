"use server"

import { redirect } from "next/navigation"
import { grantPublicAccess, getPublicPassword } from "@/lib/public-access"

export async function unlockPublicAccess(formData: FormData) {
  const password = String(formData.get("password") || "")
  const current = await getPublicPassword()
  if (!current || password !== current) redirect("/public-access?error=invalid")
  await grantPublicAccess()
  redirect("/")
}
