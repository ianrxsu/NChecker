import type { Metadata } from "next"
import { InfoPage, InfoCard } from "@/components/info-page"

// Pure static content page — prerender it as a CDN asset (no function per visit).
export const dynamic = "force-static"

export const metadata: Metadata = {
  title: "Cookie Formats — Cookies Mo",
  description:
    "Cookies Mo accepts your cookies however they were saved — as a single line, a cookies.txt file, or a JSON export. Paste any of them; no cleanup needed.",
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto border border-border bg-background p-3 font-mono text-xs leading-relaxed text-foreground">
      <code>{children}</code>
    </pre>
  )
}

export default function FormatsPage() {
  return (
    <InfoPage
      badge="Any format works"
      title="Cookie formats"
      intro="Cookies get saved in a few different ways depending on the tool or extension you used. The good news: you don't need to know which one you have. Paste it in and Cookies Mo figures it out — no cleanup required. Here's what the common formats look like."
    >
      <InfoCard title="A single line">
        <p>
          Everything on one line, with each cookie written as a name and value joined by an equals sign and separated by
          semicolons. It's the shortest, most compact way to copy cookies.
        </p>
        <CodeBlock>{`NetflixId=v%3D2%26ct%3D...; SecureNetflixId=v%3D3%26mac%3D...`}</CodeBlock>
      </InfoCard>

      <InfoCard title="A cookies.txt file">
        <p>
          The file most browser cookie extensions create when you export. Each cookie sits on its own line with a few
          extra details next to it. You can paste the text or upload the file directly.
        </p>
        <CodeBlock>{`.netflix.com TRUE / TRUE 0 NetflixId v%3D2%26ct%3D...
.netflix.com TRUE / TRUE 0 SecureNetflixId v%3D3%26mac%3D...`}</CodeBlock>
      </InfoCard>

      <InfoCard title="A JSON export">
        <p>
          A more structured export some tools produce, where each cookie is listed as a small block of details. We only
          need the name and value — you can paste the whole thing exactly as-is.
        </p>
        <CodeBlock>{`[
 { "name": "NetflixId", "value": "v%3D2%26ct%3D...", "domain": ".netflix.com" },
 { "name": "SecureNetflixId", "value": "v%3D3%26mac%3D...", "domain": ".netflix.com" }
]`}</CodeBlock>
      </InfoCard>

      <InfoCard title="Files, folders & downloads">
        <p>
          Once a check is done, you can download your results in whichever of these formats you prefer. Got a lot of
          cookies saved as files? You can also upload a <span className="font-semibold text-foreground">.zip</span> or{" "}
          <span className="font-semibold text-foreground">.rar</span> — we'll open it up and read every cookie file
          inside for you.
        </p>
      </InfoCard>
    </InfoPage>
  )
}
