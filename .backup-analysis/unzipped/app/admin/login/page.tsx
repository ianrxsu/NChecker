import { redirect } from "next/navigation"
import { isAdminAuthenticated, adminConfigured } from "@/lib/admin-auth"
import { AdminLoginForm } from "@/components/admin/admin-login-form"

export const dynamic = "force-dynamic"

export default async function AdminLoginPage() {
  if (await isAdminAuthenticated()) {
    redirect("/admin")
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Restricted</p>
          <h1 className="mt-2 text-pretty text-2xl font-semibold text-foreground">Admin Access</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Enter the admin password to view checker analytics.
          </p>
        </div>
        <AdminLoginForm configured={adminConfigured()} />
      </div>
    </main>
  )
}
