import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  description: "Rendered metadata — the md export must win in the index.",
  title: "OG_TITLE_REPORTS",
}

// Statically prerenderable, but proxy.ts guards /admin/:path* — so the build
// has HTML for it that must never be published. The md export below opts the
// route in and supplies the only body that ships.
export default function Reports() {
  return (
    <article>
      <h1>Reports</h1>
      <p>SENTINEL_REPORTS: prerendered but proxy-guarded.</p>
    </article>
  )
}

export const md: MarkdownPage = {
  content: "MD_CONTENT_REPORTS: what the reports area covers.",
  description: "MD_DESC_REPORTS",
  title: "MD_TITLE_REPORTS",
}
