import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), del: vi.fn(),
  entries: new Map<string, unknown>(),
  revalidatePath: vi.fn(),
  registrations: [] as Array<{ revalidate: number; tags: string[] }>,
}))

vi.mock("@/lib/redis", () => ({ redisEnabled: true, redis: mocks }))
vi.mock("next/cache", () => ({
  unstable_cache: (read: () => Promise<unknown>, keys: string[], options: { revalidate: number; tags: string[] }) => {
    mocks.registrations.push(options)
    return async () => {
      const key = keys.join(":")
      if (mocks.entries.has(key)) return mocks.entries.get(key)
      const value = await read()
      mocks.entries.set(key, value)
      return value
    }
  },
  revalidateTag: (tag: string, options: { expire: number }) => {
    expect(options).toEqual({ expire: 0 })
    mocks.entries.delete(tag)
  },
  revalidatePath: mocks.revalidatePath,
}))

import { getAnnouncement, saveAnnouncement, hideAnnouncement, deleteAnnouncement } from "./announcement"
import { getBrandColor, setBrandColor, DEFAULT_BRAND_COLOR } from "./brand-color"

describe("public configuration caching", () => {
  beforeEach(() => {
    mocks.entries.clear()
    vi.clearAllMocks()
  })

  it("registers five-minute tagged caches", () => {
    expect(mocks.registrations).toEqual(expect.arrayContaining([
      { revalidate: 300, tags: ["site:announcement"] },
      { revalidate: 300, tags: ["brand-color"] },
    ]))
  })

  it("reuses announcement reads but checks expiry on every call", async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    try {
      mocks.get.mockResolvedValue({ message: "Notice", expiresAt: now + 1000, hidden: false })
      expect(await getAnnouncement()).toMatchObject({ message: "Notice" })
      expect(await getAnnouncement()).toMatchObject({ message: "Notice" })
      clock.mockReturnValue(now + 1001)
      expect(await getAnnouncement()).toBeNull()
      expect(mocks.get).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it.each(["save", "hide", "delete"])("invalidates announcements and rendered pages after %s", async (operation) => {
    mocks.get.mockResolvedValue(null)
    await getAnnouncement()
    if (operation === "save") await saveAnnouncement("New notice", 1)
    if (operation === "hide") await hideAnnouncement()
    if (operation === "delete") await deleteAnnouncement()
    await getAnnouncement()
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("does not invalidate caches when a save fails", async () => {
    mocks.set.mockRejectedValueOnce(new Error("Unavailable"))
    await expect(saveAnnouncement("Notice", 1)).rejects.toThrow("Unavailable")
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it("does not cache transient announcement failures", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ message: "Recovered", expiresAt: Date.now() + 10000, hidden: false })
    expect(await getAnnouncement()).toBeNull()
    expect(await getAnnouncement()).toMatchObject({ message: "Recovered" })
  })

  it("reuses branding reads and invalidates after a successful update", async () => {
    mocks.get.mockResolvedValue("#123456")
    expect(await getBrandColor()).toMatchObject({ color: "#123456" })
    await getBrandColor()
    expect(mocks.get).toHaveBeenCalledTimes(1)
    await setBrandColor("#654321")
    mocks.get.mockResolvedValue("#654321")
    expect(await getBrandColor()).toMatchObject({ color: "#654321" })
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout")
  })

  it("falls back safely without caching failed branding reads", async () => {
    mocks.get.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce("#123456")
    expect(await getBrandColor()).toEqual({ color: DEFAULT_BRAND_COLOR, isCustom: false })
    expect(await getBrandColor()).toMatchObject({ color: "#123456" })
  })
})
