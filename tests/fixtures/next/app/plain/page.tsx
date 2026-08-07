import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  description: "Plain-value md export probe.",
  title: "Plain",
}

export default function Plain() {
  return (
    <article>
      <h1>Plain</h1>
      <p>
        SENTINEL_PLAIN: rendered body, overridden by the plain-value export.
      </p>
    </article>
  )
}

export const md: MarkdownPage = {
  content: "MD_CONTENT_PLAIN: plain-value markdown.",
  description: "MD_DESC_PLAIN",
  title: "MD_TITLE_PLAIN",
}
