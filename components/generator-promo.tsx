import Link from "next/link"
import { Sparkles } from "lucide-react"

export const ACCOUNT_GENERATOR_URL = "https://cookiesmo.i4n.tech"

export function GeneratorPromo() {
  return (
    <Link
      href={ACCOUNT_GENERATOR_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open the Cookies Mo account generator"
      className="group flex items-center gap-3 border border-primary/30 bg-primary/10 px-4 py-3 text-sm transition-colors hover:bg-primary/15"
    >
      <Sparkles className="size-4" aria-hidden />
      <span className="font-medium">Need an account? Try our free Netflix account generator</span>
      <span className="ml-auto text-xs text-primary transition-transform group-hover:translate-x-0.5">Account Generator</span>
    </Link>
  )
}
