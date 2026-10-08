import { describe, it, expect } from "vitest"
import { parseProxyLine, parseProxyBlock } from "./proxies"

describe("parseProxyLine", () => {
  it("parses bare host:port as http", () => {
    expect(parseProxyLine("101.200.158.109:8008")).toEqual({
      protocol: "http",
      host: "101.200.158.109",
      port: 8008,
      username: null,
      password: null,
    })
  })

  it("parses host:port:user:pass", () => {
    expect(parseProxyLine("1.2.3.4:8080:alice:s3cret")).toEqual({
      protocol: "http",
      host: "1.2.3.4",
      port: 8080,
      username: "alice",
      password: "s3cret",
    })
  })

  it("keeps colons inside the password (host:port:user:pass:with:colons)", () => {
    const p = parseProxyLine("1.2.3.4:8080:alice:a:b:c")
    expect(p?.username).toBe("alice")
    expect(p?.password).toBe("a:b:c")
  })

  it("parses scheme + creds (protocol://user:pass@host:port)", () => {
    expect(parseProxyLine("socks5://bob:pw@9.9.9.9:1080")).toEqual({
      protocol: "socks5",
      host: "9.9.9.9",
      port: 1080,
      username: "bob",
      password: "pw",
    })
  })

  it("normalizes socks/socks5h to socks5", () => {
    expect(parseProxyLine("socks://9.9.9.9:1080")?.protocol).toBe("socks5")
    expect(parseProxyLine("socks5h://9.9.9.9:1080")?.protocol).toBe("socks5")
  })

  it("parses https scheme", () => {
    expect(parseProxyLine("https://5.5.5.5:443")?.protocol).toBe("https")
  })

  it("parses user:pass@host:port without scheme", () => {
    expect(parseProxyLine("u:p@7.7.7.7:3128")).toEqual({
      protocol: "http",
      host: "7.7.7.7",
      port: 3128,
      username: "u",
      password: "p",
    })
  })

  it("rejects blanks, comments, and malformed lines", () => {
    expect(parseProxyLine("")).toBeNull()
    expect(parseProxyLine("   ")).toBeNull()
    expect(parseProxyLine("# a comment")).toBeNull()
    expect(parseProxyLine("// note")).toBeNull()
    expect(parseProxyLine("not-a-proxy")).toBeNull()
    expect(parseProxyLine("1.2.3.4:notaport")).toBeNull()
    expect(parseProxyLine("1.2.3.4:70000")).toBeNull()
    expect(parseProxyLine("ftp://1.2.3.4:21")).toBeNull()
  })
})

describe("parseProxyBlock", () => {
  it("parses many lines and dedupes identical endpoints", () => {
    const out = parseProxyBlock(
      ["1.2.3.4:8080", "1.2.3.4:8080", "# skip", "", "5.6.7.8:3128:u:p", "garbage"].join("\n"),
    )
    expect(out).toHaveLength(2)
    expect(out[0].host).toBe("1.2.3.4")
    expect(out[1]).toMatchObject({ host: "5.6.7.8", port: 3128, username: "u" })
  })

  it("treats different usernames on the same endpoint as distinct", () => {
    const out = parseProxyBlock(["1.2.3.4:8080:a:x", "1.2.3.4:8080:b:y"].join("\n"))
    expect(out).toHaveLength(2)
  })
})
