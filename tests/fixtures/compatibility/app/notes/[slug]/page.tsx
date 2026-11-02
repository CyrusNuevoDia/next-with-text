import type { MarkdownPage } from "next-with-text"

export function generateStaticParams() {
  return [{ slug: "alpha" }]
}

export const md: MarkdownPage<"/notes/[slug]"> = async ({ params }) =>
  `COMPAT_MD_NOTE_${(await params).slug}`

export default async function Note({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return (
    <article>
      <h1>Note {slug}</h1>
      <p>{`COMPAT_NOTE_${slug}`}</p>
    </article>
  )
}
