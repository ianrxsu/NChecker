import "server-only"
import { buildShortXLinksReturnUrl, shortenWithShortXLinks } from "@/lib/shortxlinks"
import { getWebsiteShortXApiToken } from "@/lib/shortx-routing"

const PUBLIC_ORIGIN = "https://netflixchecker.i4n.tech"

export async function buildGatewayUrl(token: string, _ip: string, shortXApiToken?: string, _forceShortX = false): Promise<string> {
  const returnUrl = buildShortXLinksReturnUrl(PUBLIC_ORIGIN, token)
  const shortened = await shortenWithShortXLinks(
    returnUrl,
    shortXApiToken ?? (await getWebsiteShortXApiToken()),
  )

  if (!shortened.ok) {
    throw new Error(shortened.error ?? "ShortXLinks could not create an unlock link")
  }

  return shortened.url
}
