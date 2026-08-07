import type { Metadata } from "next"
import { cookies } from "next/headers"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  description: "Rendered metadata — the md export must win in the index.",
  title: "OG_TITLE_GATED",
}

// Reads cookies, so the build prerenders no HTML for it — the same shape as any
// auth-gated page. Without the md export below it would appear nowhere.
export default async function Gated() {
  const jar = await cookies()
  return (
    <article>
      <h1>Gated</h1>
      <p>SENTINEL_GATED: session={jar.get("session")?.value ?? "none"}.</p>
    </article>
  )
}

// Title and description, no content: list this route, publish no body.
export const md: MarkdownPage = {
  description: "MD_DESC_GATED",
  title: "MD_TITLE_GATED",
}
