import type { NextConfig } from "next"
import {
  type MarkdownPage,
  type MarkdownProps,
  type WithTextOptions,
  withText,
} from "next-with-text"
import { createHandler } from "next-with-text/route"

const config: NextConfig = { distDir: ".compat-next" }
const options: WithTextOptions = { exclude: ["/hidden"] }
const markdown: MarkdownPage<"/notes/[slug]"> = async ({ params }) =>
  `Note ${(await params).slug}`
const props: MarkdownProps<"/notes/[slug]"> = {
  params: Promise.resolve({ slug: "alpha" }),
  searchParams: Promise.resolve({}),
}

withText(config, options)
createHandler({ dev: false, exclude: [], include: ["**/*"], md: true })
markdown(props)
