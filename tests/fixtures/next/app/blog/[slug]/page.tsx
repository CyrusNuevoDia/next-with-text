import type { Metadata } from "next"

export function generateStaticParams() {
  return [{ slug: "hello" }]
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  return {
    title: `Post: ${slug}`,
    description: `Blog post about ${slug}.`,
  }
}

export default async function Post({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  return (
    <article>
      <h1>Post: {slug}</h1>
      <p>SENTINEL_BLOG_{slug.toUpperCase()}: dynamic route content.</p>
    </article>
  )
}
