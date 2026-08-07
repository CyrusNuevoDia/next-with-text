import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import {
  type ConversionResult,
  convert,
  type HtmlMetadata,
} from "@xberg-io/html-to-markdown"
import multimatch from "multimatch"

const IMAGE_TAG = /<img\b[^>]*>/gi
const SRC_ATTRIBUTE = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const SVG_TAG = /<svg\b[\s\S]*?<\/svg\s*>/gi
const DATA_URL = /^data:/i
const WORD_SEPARATOR = /[-_]/

// The md export is the page's entire published text. A `content` publishes a
// body; a `title` with no `content` is the listing opt-in — publish this entry,
// never this page's body — which is what lets an auth-gated route appear in
// llms.txt without anything rendered from a session reaching a static file.
export type MarkdownContent =
  | string
  | { content: string; description?: string; title?: string }
  | { content?: string; description?: string; title: string }

// Params derived structurally from the route string literal, mirroring what
// Next's generated PageProps helper produces for the same route. PageProps
// itself is constrained to the project's generated AppRoutes union, which
// library code can't name — so the shape is parsed from the route instead.
type RouteParams<Route extends string> =
  Route extends `${string}[[...${infer Param}]]${infer Rest}`
    ? { [K in Param]?: string[] } & RouteParams<Rest>
    : Route extends `${string}[...${infer Param}]${infer Rest}`
      ? { [K in Param]: string[] } & RouteParams<Rest>
      : Route extends `${string}[${infer Param}]${infer Rest}`
        ? { [K in Param]: string } & RouteParams<Rest>
        : Record<never, never>

// Mirrors Next's generated PageProps helper shape-for-shape; exported so the
// function-declaration style works too:
// `export async function md({ params }: MarkdownProps<'/tags/[tag]'>) { … }`
export type MarkdownProps<Route extends string = string> = {
  params: Promise<
    string extends Route
      ? Record<string, string | string[] | undefined>
      : RouteParams<Route>
  >
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export type MarkdownPage<Route extends string = string> =
  | MarkdownContent
  | ((
      props: MarkdownProps<Route>
    ) => MarkdownContent | Promise<MarkdownContent>)

export type LlmstxtLink = {
  description: string
  href: string
  title: string
}

// A section with no title is the unheaded block the index opens with; the
// default renderer draws "## <title>" for the rest.
export type LlmstxtSection = {
  routes: LlmstxtLink[]
  title: string
}

export type LlmstxtContext = {
  description: string
  sections: LlmstxtSection[]
  title: string
}

export type WithTextOptions = {
  exclude?: string[]
  include?: string[]
  llmstxt?: (ctx: LlmstxtContext) => string
  md?: boolean
}

// The serializable subset — it crosses into the codegen'd route and the
// build-exit child as JSON. The llmstxt function travels separately.
export type ResolvedOptions = {
  exclude: string[]
  include: string[]
  md: boolean
}

// What the codegen'd route receives: the options plus the phase it was
// generated in. Baking the phase beats sniffing NODE_ENV at request time —
// Turbopack inlines whatever NODE_ENV happened to be at bundle time (under
// `bun test` that's "test"), while the config phase is what Next itself
// reported, and the file is regenerated on every config load.
export type RouteOptions = ResolvedOptions & { dev: boolean }

export function resolveOptions(options: WithTextOptions = {}): ResolvedOptions {
  return {
    exclude: options.exclude ?? [],
    include: options.include ?? ["**/*"],
    md: options.md ?? true,
  }
}

// Routes are matched with a leading-slash-stripped subject; the root route "/"
// matches as "index" so the default "**/*" include covers it.
export function matchesRoute(
  route: string,
  options: Pick<ResolvedOptions, "include" | "exclude">
): boolean {
  const patterns = [
    ...options.include.map(normalize),
    ...options.exclude.map((pattern) => `!${normalize(pattern)}`),
  ]
  return multimatch(normalize(route), patterns).length > 0
}

function normalize(routeOrPattern: string): string {
  const stripped = routeOrPattern.startsWith("/")
    ? routeOrPattern.slice(1)
    : routeOrPattern
  return stripped === "" ? "index" : stripped
}

export type PageMeta = {
  description: string
  title: string
}

// og:title is preferred over <title> because <title> carries the site template
// (e.g. "About Us | Fixture Site") while og:title is the bare page title.
export function pageMeta(metadata: HtmlMetadata | undefined): PageMeta {
  const doc = metadata?.document
  return {
    description: firstMetadata(doc?.description, doc?.openGraph?.description),
    title: firstMetadata(doc?.openGraph?.title, doc?.title),
  }
}

function firstMetadata(...values: Array<string | undefined>): string {
  return values.find((value) => value !== undefined) ?? ""
}

// Hrefs are path-absolute ("/index.md"), never origin-qualified.
export function mdUrl(route: string): string {
  return route === "/" ? "/index.md" : `${route}.md`
}

export function linkHref(route: string, mdEnabled: boolean): string {
  return mdEnabled ? mdUrl(route) : route
}

export type Link = PageMeta & { route: string }

type Section = {
  links: Link[]
  segment: string
  title: string
}

// Path-segment sections, depth 1: root-level pages (and "/") list unheaded,
// every deeper route lands under its first segment. Sections and entries sort
// alphabetically; a flat site produces a flat list.
export function groupLinks(links: Link[]): {
  root: Link[]
  sections: Section[]
} {
  const sorted = [...links].sort((a, b) => compareCodeUnits(a.route, b.route))
  const root = sorted.filter((link) => segmentsOf(link.route).length <= 1)
  const bySegment = new Map<string, Link[]>()
  for (const link of sorted) {
    const segments = segmentsOf(link.route)
    if (segments.length <= 1) {
      continue
    }
    bySegment.set(segments[0], [...(bySegment.get(segments[0]) ?? []), link])
  }
  const sections = [...bySegment.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([segment, sectionLinks]) => ({
      links: sectionLinks,
      segment,
      // the segment's own index page names the section when it exists
      title:
        links.find((link) => link.route === `/${segment}`)?.title ||
        humanize(segment),
    }))
  return { root, sections }
}

// The order the index lists routes in — llms-full.txt and the llmstxt ctx
// follow it so every surface reads in the same sequence.
export function orderLinks(links: Link[]): Link[] {
  const { root, sections } = groupLinks(links)
  return [...root, ...sections.flatMap((section) => section.links)]
}

function segmentsOf(route: string): string[] {
  return route.split("/").filter(Boolean)
}

function humanize(segment: string): string {
  return segment
    .split(WORD_SEPARATOR)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// The same grouping the default index draws, handed to a user llmstxt function
// so it can do its own sectioning. A section only exists when it has links —
// an app with no root-level pages gets no empty leading block.
export function llmstxtSections(
  links: Link[],
  mdEnabled: boolean
): LlmstxtSection[] {
  const entry = (link: Link): LlmstxtLink => ({
    description: link.description,
    href: linkHref(link.route, mdEnabled),
    title: link.title,
  })
  const { root, sections } = groupLinks(links)
  return [
    { routes: root.map(entry), title: "" },
    ...sections.map((section) => ({
      routes: section.links.map(entry),
      title: section.title,
    })),
  ].filter((section) => section.routes.length > 0)
}

export function renderIndex(
  site: PageMeta,
  links: Link[],
  mdEnabled: boolean
): string {
  const item = (link: Link) =>
    `- [${link.title}](${linkHref(link.route, mdEnabled)})${link.description ? `: ${link.description}` : ""}`
  const { root, sections } = groupLinks(links)
  const blocks = renderHeader(site)
  if (root.length > 0) {
    blocks.push(root.map(item).join("\n"))
  }
  for (const section of sections) {
    blocks.push(`## ${section.title}\n\n${section.links.map(item).join("\n")}`)
  }
  return `${blocks.join("\n\n")}\n`
}

export function renderFull(site: PageMeta, sections: string[]): string {
  return `${[...renderHeader(site), ...sections].join("\n\n")}\n`
}

// The llms-full.txt entry for a route that publishes no body: the metadata the
// page itself declared, plus the URL that renders it for whoever asks. A reader
// of llms-full alone still learns the page exists and how to fetch it.
export function renderStub(link: Link, mdEnabled: boolean): string {
  const parts = [`# ${link.title}`.trimEnd()]
  if (link.description) {
    parts.push(`> ${link.description}`)
  }
  parts.push(`[Requires session](${linkHref(link.route, mdEnabled)})`)
  return parts.join("\n\n")
}

function renderHeader(site: PageMeta): string[] {
  const parts = [`# ${site.title}`.trimEnd()]
  if (site.description) {
    parts.push(`> ${site.description}`)
  }
  return parts
}

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) {
    return markdown
  }
  const end = markdown.indexOf("\n---\n", 3)
  if (end === -1) {
    return markdown
  }
  let content = markdown.slice(end + 5)
  while (content.startsWith("\n")) {
    content = content.slice(1)
  }
  return content
}

export type ResolvedMd = {
  content?: string
  description?: string
  title?: string
}

// Evaluates a page's `md` export against the three allowed forms: plain value,
// sync function, async function — functions receive Next-shaped props with
// promise-wrapped params/searchParams.
export async function evaluateMd(
  md: unknown,
  params: Record<string, string | string[]>,
  searchParams: Record<string, string | string[]>
): Promise<ResolvedMd | null> {
  if (md === null) {
    return null
  }
  const value =
    typeof md === "function"
      ? await (md as (props: unknown) => unknown)({
          params: Promise.resolve(params),
          searchParams: Promise.resolve(searchParams),
        })
      : md
  if (typeof value === "string") {
    return { content: value }
  }
  if (value && typeof value === "object") {
    const { content, title } = value as { content?: unknown; title?: unknown }
    // a title alone is enough: that is the opt-in form, carrying no body
    if (typeof content === "string" || typeof title === "string") {
      return value as ResolvedMd
    }
  }
  return null
}

// Matches a concrete route against an app-dir pattern ("/tags/alpha" vs
// "/tags/[tag]"), returning the captured params or null.
export function matchPattern(
  route: string,
  pattern: string
): Record<string, string> | null {
  const routeSegments = segmentsOf(route)
  const patternSegments = segmentsOf(pattern)
  if (routeSegments.length !== patternSegments.length) {
    return null
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < patternSegments.length; i += 1) {
    const segment = patternSegments[i]
    if (
      segment.startsWith("[") &&
      segment.endsWith("]") &&
      !segment.startsWith("[...")
    ) {
      params[segment.slice(1, -1)] = decodeURIComponent(routeSegments[i])
    } else if (segment !== routeSegments[i]) {
      return null
    }
  }
  return params
}

export const CONVERT_OPTIONS = { excludeSelectors: ["footer"] }

export function convertHTML(html: string): ConversionResult {
  return convert(stripInlineImages(html), CONVERT_OPTIONS)
}

function stripInlineImages(html: string): string {
  return html.replace(SVG_TAG, "").replace(IMAGE_TAG, (image) => {
    const src = image.match(SRC_ATTRIBUTE)
    const path = src?.[1] ?? src?.[2] ?? src?.[3]
    return path && !DATA_URL.test(path) ? image : ""
  })
}

export function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1
  }
  if (a > b) {
    return 1
  }
  return 0
}

export function isPageFile(name: string): boolean {
  const dot = name.lastIndexOf(".")
  return (
    name.slice(0, dot) === "page" &&
    ["tsx", "jsx", "ts", "js", "mdx"].includes(name.slice(dot + 1))
  )
}

// The body a page publishes: its md export's content when it declares one,
// otherwise the rendered conversion. A titled export that declares no content
// publishes nothing — null, meaning no .md twin is written and llms-full.txt
// carries a stub. That is what keeps a gated page's rendering off every static
// surface while still letting it appear in the index.
export function publishedBody(
  override: ResolvedMd | null,
  converted: string | undefined
): string | null {
  if (override?.content !== undefined) {
    return override.content
  }
  if (override?.title !== undefined) {
    return null
  }
  return converted ?? ""
}

// The built HTML in .next/server/app IS the route list: prerendered pages
// only, so auth-gated dynamic pages are absent by construction (dynamic
// instances from generateStaticParams included). Returns null when no build
// output exists — dev, or a serverless function bundle that traced none of it.
export function discoverBuiltRoutes(dir: string): string[] | null {
  const serverApp = join(dir, ".next", "server", "app")
  try {
    if (!existsSync(serverApp)) {
      return null
    }
    const routes: string[] = []
    walk(serverApp)
    return routes.sort(compareCodeUnits)

    function walk(current: string): void {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const { name } = entry
        if (name.startsWith("_") || name.startsWith("%5F")) {
          continue
        }
        if (entry.isDirectory()) {
          walk(join(current, name))
          continue
        }
        if (!name.endsWith(".html")) {
          continue
        }
        const rel = relative(serverApp, join(current, name)).slice(
          0,
          -".html".length
        )
        if (rel === "404" || rel === "500") {
          continue
        }
        routes.push(rel === "index" ? "/" : `/${rel.split(sep).join("/")}`)
      }
    }
  } catch {
    return null
  }
}

// Every page compiles to .next/server/app/<route>/page.js whether or not it
// prerendered to HTML, so this is the one place a build can see the routes
// discoverBuiltRoutes can't — the auth-gated and otherwise dynamic ones. Only
// literal paths: /users/[id] has no concrete URL to publish, so a dynamic
// segment ends that branch.
export function discoverModuleRoutes(dir: string): string[] {
  const serverApp = join(dir, ".next", "server", "app")
  try {
    if (!existsSync(serverApp)) {
      return []
    }
    const routes: string[] = []
    walk(serverApp, "")
    return routes.sort(compareCodeUnits)

    function walk(current: string, route: string): void {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const { name } = entry
        if (!entry.isDirectory()) {
          if (name === "page.js") {
            routes.push(route === "" ? "/" : route)
          }
          continue
        }
        // "page"/"route" hold a compiled page's manifests, and *.segments its
        // RSC payloads — neither is a route segment. Dots are matched only at
        // that suffix: /docs/v1.2 is a perfectly legal route directory.
        if (
          name.startsWith("_") ||
          name.startsWith("%5F") ||
          name.startsWith("@") ||
          name.startsWith("[") ||
          name === "page" ||
          name === "route" ||
          name.endsWith(".segments")
        ) {
          continue
        }
        walk(join(current, name), `${route}/${name}`)
      }
    }
  } catch {
    return []
  }
}

// Next 16 exposes proxy.ts matchers (compiled regexp + originalSource) in the
// build's functions-config-manifest.json — middleware-manifest.json stays
// empty, and dev writes no such manifest (so dev applies no proxy exclusion,
// same as it always has). The path is a literal-suffixed join so Turbopack can
// scope its tracing to .next instead of the whole project.
export function readProxyMatchers(dir: string): RegExp[] {
  const manifestPath = join(dir, ".next/server/functions-config-manifest.json")
  try {
    if (!existsSync(manifestPath)) {
      return []
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      functions?: Record<string, { matchers?: Array<{ regexp: string }> }>
    }
    return Object.values(manifest.functions ?? {})
      .flatMap((fn) => fn.matchers ?? [])
      .map((matcher) => new RegExp(matcher.regexp))
  } catch {
    // a corrupt manifest just skips exclusion for this build
    return []
  }
}
