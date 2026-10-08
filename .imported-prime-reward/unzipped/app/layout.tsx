import { Analytics } from "@vercel/analytics/next"
import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import { ThemeProvider } from "@/components/theme-provider"
import { SplashScreen } from "@/components/splash-screen"
import { SoundEffects } from "@/components/sound-effects"
import { SuppressResizeObserverError } from "@/components/suppress-resize-observer-error"
import { getBrandColor, brandCssVars, DEFAULT_BRAND_COLOR } from "@/lib/brand-color"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "Cookies Mo — Best Cookies Checker",
  description:
    "Cookies Mo instantly checks whether your Netflix, Amazon Prime, and Crunchyroll cookies still work — one at a time or thousands at once. Paste them in any format and get clear results in seconds. Nothing is saved.",
  generator: "v0.app",
  icons: {
    // Dynamic, brand-colored cookie favicon. The route paints the tile with the
    // site's current main color so the favicon tracks admin changes.
    icon: [{ url: "/api/icon", type: "image/svg+xml" }],
    apple: "/apple-icon.png",
  },
}

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Resolve the admin-set main color on the server so the whole app renders in the
  // correct brand color on first paint (no flash). When it's the default teal we
  // skip the override entirely and let globals.css drive the tokens.
  const { color, isCustom } = await getBrandColor()
  const brandStyle =
    isCustom && color !== DEFAULT_BRAND_COLOR
      ? `:root,.dark{${Object.entries(brandCssVars(color))
          .map(([k, v]) => `${k}:${v}`)
          .join(";")}}`
      : null

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} bg-background`}
      suppressHydrationWarning
    >
      {brandStyle && (
        // Let React 19 hoist this into <head> and manage it as a keyed stylesheet.
        // We must NOT render a manual <head> here: Next.js owns the head and (in
        // dev) injects its own <style> tags, so a hand-rolled <head> made the
        // server/client disagree on head children and threw a hydration mismatch.
        // `href` + `precedence` give React a stable identity so ordering is
        // deterministic across SSR and hydration.
        <style href="brand-color-override" precedence="high">
          {brandStyle}
        </style>
      )}
      <body className="bg-background font-mono antialiased" suppressHydrationWarning>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          <div className="tc-ambient" aria-hidden />
          <SuppressResizeObserverError />
          <SplashScreen />
          <SoundEffects />
          {children}
          <Toaster position="top-right" closeButton />
          {process.env.NODE_ENV === "production" && <Analytics />}
        </ThemeProvider>
      </body>
    </html>
  )
}
