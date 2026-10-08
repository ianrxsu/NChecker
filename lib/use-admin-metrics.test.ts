import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), swr: vi.fn() }))
vi.mock("swr", () => ({ default: mocks.swr }))

import { useAdminMetrics, type AdminData } from "./use-admin-metrics"

describe("admin metrics refresh policy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.swr.mockReturnValue({ data: undefined, error: undefined, mutate: mocks.mutate })
  })

  function renderHook() {
    const initial = { generatedAt: 123 } as AdminData
    let result: ReturnType<typeof useAdminMetrics> | undefined
    function Probe() {
      result = useAdminMetrics(initial)
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return { initial, result: result! }
  }

  it("uses server data without mount, focus, reconnect, or interval requests", () => {
    const { initial, result } = renderHook()
    expect(result.data).toBe(initial)
    expect(mocks.swr).toHaveBeenCalledWith("/api/admin/metrics", expect.any(Function), expect.objectContaining({
      fallbackData: initial,
      refreshInterval: 0,
      revalidateOnMount: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    }))
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it("keeps the explicit Refresh action operational", async () => {
    const { result } = renderHook()
    await result.refresh()
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
  })
})
