import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  title: "Plain",
  description: "Plain-value md export probe.",
}

export default function Plain() {
  return (
    <article>
      <h1>Plain</h1>
      <p>SENTINEL_PLAIN: rendered body, overridden by the plain-value export.</p>
    </article>
  )
}

export const md: MarkdownPage = {
  title: "MD_TITLE_PLAIN",
  description: "MD_DESC_PLAIN",
  content: "MD_CONTENT_PLAIN: plain-value markdown.",
}
