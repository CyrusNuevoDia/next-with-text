import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  compareCodeUnits,
  convertHTML,
  discoverBuiltRoutes,
  evaluateMd,
  isPageFile,
  type Link,
  matchesRoute,
  matchPattern,
  orderLinks,
  type PageMeta,
  pageMeta,
  publishedBody,
  type ResolvedMd,
  type RouteOptions,
  readProxyMatchers,
  renderFull,
  renderIndex,
  renderStub,
  stripFrontmatter,
} from "./shared.js"

type RouteContext = {
  params: Promise<{ path: string[] }>
}
type Loaders = Record<string, () => Promise<unknown>>
type ServedPage = {
  // null when the page publishes no body — llms-full.txt carries a stub
  content: string | null
  meta: PageMeta
  rendered: PageMeta
  route: string
}

// The on-demand tier behind the generated /_llms/[...path] route: serves the
// llms surfaces when no static public file matched — all of dev, plus dynamic
// pages in next start / serverless. Pages with an `md` export evaluate it via
// the codegen'd loader manifest; everything else self-fetches this deployment's
// own origin and converts live, with cookies forwarded so authed pages render
// the requester's view.
export function createHandler(options: RouteOptions, loaders: Loaders = {}) {
  return async function GET(
    req: Request,
    ctx: RouteContext
  ): Promise<Response> {
    const { path } = await ctx.params
    const target = path.join("/")
    const origin = requestOrigin(req)

    if (target === "llms.txt" || target === "llms-full.txt") {
      return serveSurface(target, origin, options, loaders)
    }

    if (!(target.endsWith(".md") && options.md)) {
      return notFound()
    }
    const markdownTarget = target.slice(0, -".md".length)
    const route = markdownTarget === "index" ? "/" : `/${markdownTarget}`
    if (!matchesRoute(route, options)) {
      return notFound()
    }

    const override = await evaluateOverride(loaders, route, searchParamsOf(req))
    if (override?.content !== undefined) {
      return respond(override.content, "text/markdown")
    }

    // A titled export declaring no content leaves the body to the live page, so
    // the fetch carries the caller's own cookies and renders their own view —
    // the reason a gated route can be listed and still answer honestly.
    const cookie = req.headers.get("cookie")
    const html = await fetchPage(origin, route, cookie)
    if (html === null) {
      return override?.title === undefined
        ? notFound()
        : respond(stubFor(route, override, options.md), "text/markdown")
    }
    return respond(
      convertHTML(html).content ?? "",
      "text/markdown",
      cookie !== null
    )
  }
}

// An opted-in route that the caller can't render (no session, or an auth guard
// turned them away) still answers with what the page declared about itself.
function stubFor(
  route: string,
  override: ResolvedMd,
  mdEnabled: boolean
): string {
  return renderStub(
    {
      description: override.description ?? "",
      route,
      title: override.title ?? "",
    },
    mdEnabled
  )
}

// Static patterns win over dynamic ones ("/tags/list" beats "/tags/[tag]").
function evaluateOverride(
  loaders: Loaders,
  route: string,
  searchParams: Record<string, string | string[]>
): Promise<ResolvedMd | null> {
  const patterns = Object.keys(loaders).sort(comparePatterns)
  return evaluateCandidate(patterns, 0)

  async function evaluateCandidate(
    candidates: string[],
    index: number
  ): Promise<ResolvedMd | null> {
    const pattern = candidates[index]
    if (pattern === undefined) {
      return null
    }
    const params = matchPattern(route, pattern)
    const load = loaders[pattern]
    if (params && load) {
      try {
        const mod = (await load()) as { md?: unknown }
        const value = await evaluateMd(mod.md, params, searchParams)
        if (value) {
          return value
        }
      } catch {
        // a page module that fails to load falls back to HTML conversion
      }
    }
    return evaluateCandidate(candidates, index + 1)
  }
}

async function optedInRoutes(
  loaders: Loaders,
  discovered: string[],
  options: RouteOptions
): Promise<string[]> {
  const candidates = Object.keys(loaders).filter(
    (pattern) =>
      !(pattern.includes("[") || discovered.includes(pattern)) &&
      matchesRoute(pattern, options)
  )
  const titled = await Promise.all(
    candidates.map(async (pattern) =>
      (await evaluateOverride(loaders, pattern, {}))?.title === undefined
        ? null
        : pattern
    )
  )
  return titled.filter((pattern): pattern is string => pattern !== null)
}

function comparePatterns(a: string, b: string): number {
  const dynamicOrder = Number(a.includes("[")) - Number(b.includes("["))
  return dynamicOrder || compareCodeUnits(a, b)
}

async function serveSurface(
  kind: "llms.txt" | "llms-full.txt",
  origin: string,
  options: RouteOptions,
  loaders: Loaders
): Promise<Response> {
  const discovered = discoverRoutes(options.dev).filter((route) =>
    matchesRoute(route, options)
  )
  // Gated routes are missing from that list by construction — nothing
  // prerendered, or a proxy matcher covers them. A literal-path page exporting
  // a titled md is opting in, so add it back; dynamic patterns never can,
  // having no concrete URL to publish.
  const optIn = await optedInRoutes(loaders, discovered, options)

  const pages = (
    await Promise.all(
      [...discovered, ...optIn].map(
        async (route): Promise<ServedPage | null> => {
          const override = await evaluateOverride(loaders, route, {})
          const declared: ServedPage | null =
            override?.title === undefined
              ? null
              : {
                  content: override.content ?? null,
                  meta: {
                    description: override.description ?? "",
                    title: override.title,
                  },
                  rendered: { description: "", title: "" },
                  route,
                }
          if (!discovered.includes(route)) {
            return declared
          }
          // unauthenticated fetch: a page an auth guard turns away publishes
          // only what it declared, and drops out entirely if it declared nothing
          const html = await fetchPage(origin, route, null)
          if (html === null) {
            return declared
          }
          const result = convertHTML(html)
          const rendered = pageMeta(result.metadata)
          return {
            content: publishedBody(override, result.content),
            meta: {
              description: override?.description ?? rendered.description,
              title: override?.title ?? rendered.title,
            },
            rendered,
            route,
          }
        }
      )
    )
  ).filter((page): page is ServedPage => page !== null)

  const site = await siteMeta(origin, pages)
  const links: Link[] = pages.map((page) => ({
    route: page.route,
    ...page.meta,
  }))
  if (kind === "llms.txt") {
    return respond(renderIndex(site, links, options.md), "text/plain")
  }
  const byRoute = new Map(pages.map((page) => [page.route, page]))
  const sections = orderLinks(links).map((link) => {
    const content = byRoute.get(link.route)?.content
    return content === null || content === undefined
      ? renderStub(link, options.md)
      : stripFrontmatter(content).trim()
  })
  return respond(renderFull(site, sections), "text/plain")
}

// Two route lists, picked by the phase baked in at codegen. Dev walks the live
// app/ tree (the source is the truth there, and a stale .next from an earlier
// build must not shadow it); dynamic segments can't be enumerated by a walk,
// so they appear only as .md twins, not in the index. Everywhere else the
// built HTML in .next/server/app is the list — prerendered pages only, so
// auth-gated dynamic pages stay out of the index by construction. A serverless
// bundle has neither (deploy builds ship static public files instead) and
// degrades to an empty list.
function discoverRoutes(dev: boolean): string[] {
  const dir = process.cwd()
  const routes = dev ? walkAppRoutes(dir) : (discoverBuiltRoutes(dir) ?? [])
  const proxyMatchers = readProxyMatchers(dir)
  return routes.filter((route) => !proxyMatchers.some((re) => re.test(route)))
}

function walkAppRoutes(dir: string): string[] {
  const srcApp = join(dir, "src/app")
  const plainApp = join(dir, "app")
  const appDir = resolveAppDirectory(srcApp, plainApp)
  if (!appDir) {
    return []
  }
  const routes: string[] = []
  walk(appDir, "")
  return routes.sort(compareCodeUnits)

  function walk(current: string, route: string): void {
    const entries = readdirSync(current, { withFileTypes: true })
    if (entries.some((entry) => entry.isFile() && isPageFile(entry.name))) {
      routes.push(route === "" ? "/" : route)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const { name } = entry
      if (
        name.startsWith("_") ||
        name.startsWith("%5F") ||
        name.startsWith("@") ||
        name.includes("[")
      ) {
        continue
      }
      walk(
        join(current, name),
        name.startsWith("(") ? route : `${route}/${name}`
      )
    }
  }
}

function resolveAppDirectory(srcApp: string, plainApp: string): string | null {
  if (existsSync(srcApp)) {
    return srcApp
  }
  return existsSync(plainApp) ? plainApp : null
}

async function siteMeta(
  origin: string,
  pages: ServedPage[]
): Promise<PageMeta> {
  const root = pages.find((page) => page.route === "/")
  if (root) {
    return root.rendered
  }
  const html = await fetchPage(origin, "/", null)
  return html === null
    ? { description: "", title: "" }
    : pageMeta(convertHTML(html).metadata)
}

async function fetchPage(
  origin: string,
  route: string,
  cookie: string | null
): Promise<string | null> {
  try {
    const res = await fetch(`${origin}${route}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    })
    if (!res.ok) {
      return null
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/html")) {
      return null
    }
    return await res.text()
  } catch {
    return null
  }
}

function searchParamsOf(req: Request): Record<string, string | string[]> {
  const { searchParams } = new URL(req.url)
  const result: Record<string, string | string[]> = {}
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key)
    result[key] = values.length > 1 ? values : (values[0] ?? "")
  }
  return result
}

function requestOrigin(req: Request): string {
  const url = new URL(req.url)
  const proto =
    req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host
  return `${proto}://${host}`
}

// A body rendered from the caller's cookies is theirs alone: mark it private so
// a CDN that caches without varying on Cookie can't hand it to the next visitor.
function respond(
  body: string,
  type: "text/markdown" | "text/plain",
  personalized = false
): Response {
  const headers: Record<string, string> = {
    "content-type": `${type}; charset=utf-8`,
  }
  if (personalized) {
    headers["cache-control"] = "private, no-store"
  }
  return new Response(body, { headers })
}

function notFound(): Response {
  return new Response("Not found", { status: 404 })
}
