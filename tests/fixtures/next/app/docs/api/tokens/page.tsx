import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  title: "OG_TITLE_TOKENS",
  description: "Rendered metadata description — the md export must override this in the index.",
}

export default function APITokens() {
  return (
    <article>
      <h1>API Tokens</h1>
      <p>SENTINEL_TOKENS: rotate tokens quarterly.</p>
    </article>
  )
}

export const md: MarkdownPage = async () => ({
  title: "MD_TITLE_TOKENS",
  description: "MD_DESC_TOKENS",
  content: "MD_CONTENT_TOKENS: token docs as markdown.",
})
