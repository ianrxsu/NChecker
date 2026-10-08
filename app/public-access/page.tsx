import type { Metadata } from "next"
import { ArrowRight, ArrowUpRight, LockKeyhole } from "lucide-react"
import { CookieMark } from "@/components/cookie-mark"
import { ModeToggle } from "@/components/mode-toggle"
import { unlockPublicAccess } from "./actions"

export const metadata: Metadata = { title: "Private access — Cookies Mo", description: "Enter the website password to access Cookies Mo." }

export default async function PublicAccessPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  return <main className="flex min-h-svh flex-col bg-background text-foreground">
    <header className="flex items-center justify-between px-6 py-6 sm:px-10"><div className="flex items-center gap-3"><span className="size-9 overflow-hidden rounded-xl"><CookieMark /></span><span className="text-lg font-semibold tracking-tight">Cookies Mo.</span></div><ModeToggle /></header>
    <div className="flex flex-1 items-center justify-center px-5 py-12">
      <section className="flex w-full max-w-md flex-col gap-7 rounded-3xl border border-border bg-card p-7 text-card-foreground sm:p-10">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><LockKeyhole className="size-5" aria-hidden /></span>
        <div className="flex flex-col gap-3"><p className="text-sm font-medium text-primary">Private access</p><h1 className="text-balance text-3xl font-semibold tracking-tight">You&apos;re almost in.</h1><p className="text-base leading-relaxed text-muted-foreground">Enter the website password from the pinned message in our Telegram group.</p></div>
        {error && <p id="password-error" role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">Incorrect password. Please try again.</p>}
        <form action={unlockPublicAccess} className="flex flex-col gap-4"><label htmlFor="password" className="text-sm font-medium">Website password</label><input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={!!error} aria-describedby={error ? "password-error" : undefined} placeholder="Enter your password" className="min-h-12 border border-input bg-background px-4 text-base text-foreground outline-none focus:ring-2 focus:ring-ring" /><button className="inline-flex min-h-12 items-center justify-center gap-3 rounded-full bg-primary px-5 text-base font-semibold text-primary-foreground hover:opacity-90" type="submit">Unlock site<ArrowRight className="size-4" aria-hidden /></button></form>
        <a className="inline-flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary" href="https://t.me/+GGANKCF7fsg2YjVl" target="_blank" rel="noopener noreferrer">Find the password on Telegram<ArrowUpRight className="size-4" aria-hidden /></a>
      </section>
    </div>
    <p className="pb-8 text-center text-sm text-muted-foreground">Cookies Mo — your tools, in one place.</p>
  </main>
}
