import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  description: "Dynamic page that echoes its query string.",
  title: "Echo",
}

export default async function Echo({ searchParams }: PageProps<"/echo">) {
  const { q } = await searchParams
  return (
    <article>
      <h1>Echo</h1>
      <p>SENTINEL_ECHO: q={String(q ?? "none")}.</p>
    </article>
  )
}

export const md: MarkdownPage<"/echo"> = async ({ searchParams }) =>
  `MD_ECHO_${String((await searchParams).q ?? "none")}: echoed markdown.`
