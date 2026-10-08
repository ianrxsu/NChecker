// Shared admin section identifiers. Kept in a PLAIN (non-"use client") module so
// the server admin route can import the runtime `ADMIN_SECTIONS` array to validate
// the URL slug. Importing a runtime value from a "use client" component would yield
// a client reference (not the real array), which is why this lives on its own.

export type SectionId =
  | "overview"
  | "checker"
  | "saved"
  | "prime-checker"
  | "prime-saved"
  | "crunchyroll-checker"
  | "crunchyroll-saved"
  | "analytics"
  | "activity"
  | "system"
  | "access-codes"

// Every valid section id (order matches the sidebar nav). Used by the server route
// to validate the path slug and by the panel to render navigation.
export const ADMIN_SECTIONS: SectionId[] = [
  "overview",
  "checker",
  "saved",
  "prime-checker",
  "prime-saved",
  "crunchyroll-checker",
  "crunchyroll-saved",
  "analytics",
  "activity",
  "system",
  "access-codes",
]

// Section ids that host an embedded checker (single/bulk modes live in the URL).
export const CHECKER_SECTIONS: SectionId[] = [
  "checker",
  "prime-checker",
  "crunchyroll-checker",
]
