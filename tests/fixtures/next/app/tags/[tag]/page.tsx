import type { Metadata } from "next"
import type { MarkdownProps } from "next-with-text"

export function generateStaticParams() {
  return [{ tag: "alpha" }, { tag: "beta" }]
}

export async function generateMetadata({
  params,
}: PageProps<"/tags/[tag]">): Promise<Metadata> {
  const { tag } = await params
  return {
    description: `Pages tagged ${tag}.`,
    title: `Tag: ${tag}`,
  }
}

export default async function Tag({ params }: PageProps<"/tags/[tag]">) {
  const { tag } = await params
  return (
    <article>
      <h1>Tag: {tag}</h1>
      <p>SENTINEL_TAG_{tag.toUpperCase()}: tagged content.</p>
    </article>
  )
}

export async function md({ params }: MarkdownProps<"/tags/[tag]">) {
  return `MD_TAG_${(await params).tag}: tag page markdown.`
}
