import { createHmac, timingSafeEqual } from "crypto"

export const LOCAL_COOKIE = "cm_generator_local"

export function createLocalGeneratorCookie(): string {
  return `1.${signature()}`
}

function signature(): string {
  return createHmac("sha256", process.env.GENERATOR_SECRET_CODE || "missing-generator-secret")
    .update("local-generator-session")
    .digest("base64url")
}

export function isValidLocalGeneratorCookie(value: string | undefined): boolean {
  if (!value) return false
  const [marker, provided] = value.split(".")
  if (marker !== "1" || !provided) return false
  const expected = Buffer.from(signature())
  const actual = Buffer.from(provided)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
