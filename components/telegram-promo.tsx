import Link from "next/link"
import { Send } from "lucide-react"

export const TELEGRAM_CHANNEL_URL = "https://t.me/+6thwMw2f-7I1ZTZl"
export const TELEGRAM_BOT_URL = "https://t.me/cookiesmo_bot"

export function TelegramBotPromo() {
  return (
    <Link
      href={TELEGRAM_BOT_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open the Cookies Mo Telegram bot"
      className="group flex items-center justify-between gap-3 border border-primary/30 bg-primary/10 px-4 py-3 text-sm transition-colors hover:bg-primary/15"
    >
      <span className="font-medium">Claim limit reached? Use our telegram bot! Same features, separate limits.</span>
      <span className="shrink-0 text-xs text-primary transition-transform group-hover:translate-x-0.5">Open bot</span>
    </Link>
  )
}

export function TelegramPromo({ compact = false }: { compact?: boolean }) {
  return (
    <Link
      href={TELEGRAM_CHANNEL_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Join our Telegram channel"
      className={compact
        ? "press inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-primary transition-colors hover:bg-primary/20"
        : "group flex items-center gap-3 border border-primary/30 bg-primary/10 px-4 py-3 text-sm transition-colors hover:bg-primary/15"}
    >
      <Send className={compact ? "size-3.5" : "size-4"} aria-hidden />
      <span className={compact ? "hidden sm:inline" : "font-medium"}>
        {compact ? "Join Telegram" : "Join our Telegram channel for updates"}
      </span>
      {!compact && <span className="ml-auto text-xs text-primary transition-transform group-hover:translate-x-0.5">Open channel</span>}
    </Link>
  )
}
