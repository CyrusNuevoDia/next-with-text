import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import multimatch from "multimatch"

export type MarkdownContent =
  | string
  | { title: string; description: string; content: string }

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
        : {}

// Mirrors Next's generated PageProps helper shape-for-shape; exported so the
// function-declaration style works too:
// `export async function md({ params }: MarkdownProps<'/tags/[tag]'>) { … }`
export interface MarkdownProps<Route extends string = string> {
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

export interface LlmstxtContext {
  description: string
  routes: { title: string; description: string; href: string }[]
  title: string
}

export interface WithTextOptions {
  exclude?: string[]
  include?: string[]
  llmstxt?: (ctx: LlmstxtContext) => string
  md?: boolean
}

// The serializable subset — it crosses into the codegen'd route and the
// build-exit child as JSON. The llmstxt function travels separately.
export interface ResolvedOptions {
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
  const stripped = routeOrPattern.replace(/^\//, "")
  return stripped === "" ? "index" : stripped
}

export interface PageMeta {
  description: string
  title: string
}

// og:title is preferred over <title> because <title> carries the site template
// (e.g. "About Us | Fixture Site") while og:title is the bare page title.
export function pageMeta(metadata: unknown): PageMeta {
  const doc =
    (
      metadata as {
        document?: {
          title?: string
          description?: string
          openGraph?: { title?: string; description?: string }
        }
      }
    )?.document ?? {}
  return {
    description: doc.description ?? doc.openGraph?.description ?? "",
    title: doc.openGraph?.title ?? doc.title ?? "",
  }
}

// Hrefs are path-absolute ("/index.md"), never origin-qualified.
export function mdUrl(route: string): string {
  return route === "/" ? "/index.md" : `${route}.md`
}

export function linkHref(route: string, mdEnabled: boolean): string {
  return mdEnabled ? mdUrl(route) : route
}

export type Link = PageMeta & { route: string }

interface Section {
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
  const sorted = [...links].sort((a, b) =>
    a.route < b.route ? -1 : a.route > b.route ? 1 : 0
  )
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
    .sort(([a], [b]) => (a < b ? -1 : 1))
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
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
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
  return markdown.slice(end + 5).replace(/^\n+/, "")
}

export interface ResolvedMd {
  content: string
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
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { content?: unknown }).content === "string"
  ) {
    return value as ResolvedMd
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
  for (let i = 0; i < patternSegments.length; i++) {
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
    return routes.sort()

    function walk(current: string): void {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const name = entry.name
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
