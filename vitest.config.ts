import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", ".imported-prime-reward/**"],
  },
})
