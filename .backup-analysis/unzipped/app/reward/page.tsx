import { redirect } from "next/navigation"

// The selection flow moved to /account-generator. Preserve any old links.
export default function RewardRedirect() {
  redirect("/account-generator")
}
