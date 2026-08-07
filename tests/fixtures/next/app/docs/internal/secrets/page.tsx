import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  description: "Excluded page.",
  title: "Internal Secrets",
}

export default function Secrets() {
  return (
    <article>
      <h1>Internal Secrets</h1>
      <p>SENTINEL_SECRETS: this must never appear in llms output.</p>
    </article>
  )
}

// This page asks to be listed. The `exclude` pattern in next.config.ts must
// still win — config is the kill switch, and no page export may override it.
export const md: MarkdownPage = {
  description: "MD_DESC_SECRETS",
  title: "MD_TITLE_SECRETS",
}
