import { describe, it, expect } from "vitest"
import { __classify } from "./prime-native"

const { classifyPaid, classifyCustomerState } = __classify

describe("classifyPaid — Prime membership signal (alive=prime, dead=no-prime)", () => {
  it("returns 'paid' when the watchlist flag is enabled", () => {
    expect(classifyPaid('x {"watchlistAction":{"ajaxEnabled":true}} y')).toBe("paid")
  })

  it("returns 'paid' on other positive member signals", () => {
    expect(classifyPaid('"isPrimeMember":true')).toBe("paid")
    expect(classifyPaid('"hasPrimeSubscription":true')).toBe("paid")
  })

  it("returns 'free' ONLY on an authoritative structured no-Prime flag", () => {
    expect(classifyPaid('{"watchlistAction":{"ajaxEnabled":false}}')).toBe("free")
    expect(classifyPaid('"isPrimeMember":false')).toBe("free")
    expect(classifyPaid('"hasPrimeSubscription":false')).toBe("free")
    expect(classifyPaid('"benefitId":"PRIME_NONE"')).toBe("free")
  })

  // Regression guard for the false-dead bug: marketing-copy upsells ("subscribe
  // now", "join prime", "get prime", "free trial") appear on PAID accounts' pages
  // too, so they must NOT yield a "free" (dead) verdict — they're indeterminate.
  it("does NOT treat marketing-copy upsells as no-Prime", () => {
    expect(classifyPaid("<div>Subscribe now to watch</div>")).toBeNull()
    expect(classifyPaid("Join Prime today")).toBeNull()
    expect(classifyPaid("Get Prime Student free trial")).toBeNull()
    // A signed-in nav alone proves login, not membership → indeterminate (terminal).
    expect(classifyPaid('<button data-testid="pv-nav-sign-out">Sign out</button>')).toBeNull()
  })

  // An authenticated session with NO membership signal is indeterminate (null). The
  // caller treats this as authoritative DEAD "No Prime" — never alive (kept out of
  // the pool and rewards), deleted on a saved recheck, and terminal (never retried,
  // since the answer is deterministic for a logged-in account).
  it("returns null (indeterminate) for a logged-in page with no membership signal", () => {
    expect(classifyPaid("<html><body>Prime Video storefront content</body></html>")).toBeNull()
    expect(classifyPaid("")).toBeNull()
  })
})

describe("classifyCustomerState — authoritative auth via config customerID", () => {
  it("authenticated when customerID is present and non-empty", () => {
    const { state } = classifyCustomerState({ customerID: "A1B2C3D4E5" }, "")
    expect(state).toBe("authenticated")
  })

  it("logged_out when customerID key is present but empty", () => {
    const { state } = classifyCustomerState({ customerID: "" }, "")
    expect(state).toBe("logged_out")
  })

  it("unavailable when customerID key is absent (retry, not dead)", () => {
    const { state } = classifyCustomerState({ someOtherKey: 1 }, "")
    expect(state).toBe("unavailable")
  })

  it("falls back to raw-text customerID when JSON lacks it", () => {
    const { state, customerId } = classifyCustomerState({}, '...{"customerID":"ZZ9988"}...')
    expect(state).toBe("authenticated")
    expect(customerId).toBe("ZZ9988")
  })
})
