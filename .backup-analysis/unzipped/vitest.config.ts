import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    // Mirror the tsconfig "@/*" path alias so unit tests can import modules that
    // use absolute "@/..." imports (e.g. lib/proxies.ts → @/lib/db).
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{ts,tsx}"],
  },
})
