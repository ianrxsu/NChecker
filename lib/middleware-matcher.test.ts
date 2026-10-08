import { describe, expect, it, vi } from "vitest"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"

vi.mock("@/lib/maintenance-mode", () => ({ isMaintenanceEnabled: vi.fn() }))
vi.mock("@/lib/public-access", () => ({
  PUBLIC_ACCESS_COOKIE: "public-access",
  isPublicAccessEnabled: vi.fn(),
  validPublicAccessCookie: vi.fn(),
}))

import { config } from "../middleware"

describe("middleware invocation scope", () => {
  it.each(["/admin", "/admin/login", "/api/admin/metrics", "/api/reward/claim", "/public-access", "/maintenance", "/_next/static/chunk.js", "/icon.png"])("does not invoke middleware for exempt route %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false)
  })

  it.each(["/", "/docs", "/unlock", "/account-generator", "/prime/account-generator", "/netflix", "/docs?_rsc=test", "/administrator"])("preserves public page gates for %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true)
  })
})
