import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { convert } from "@xberg-io/html-to-markdown"
import {
  CONVERT_OPTIONS,
  discoverBuiltRoutes,
  evaluateMd,
  type Link,
  matchesRoute,
  matchPattern,
  orderLinks,
  type PageMeta,
  pageMeta,
  type ResolvedMd,
  type RouteOptions,
  readProxyMatchers,
  renderFull,
  renderIndex,
  stripFrontmatter,
} from "./shared"

interface RouteContext {
  params: Promise<{ path: string[] }>
}
type Loaders = Record<string, () => Promise<unknown>>
interface ServedPage {
  content: string
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
    const target = (path ?? []).join("/")
    const origin = requestOrigin(req)

    if (target === "llms.txt" || target === "llms-full.txt") {
      return serveSurface(target, origin, options, loaders)
    }

    if (!(target.endsWith(".md") && options.md)) {
      return notFound()
    }
    const route = `/${target.replace(/\.md$/, "").replace(/^index$/, "")}`
    if (!matchesRoute(route, options)) {
      return notFound()
    }

    const override = await evaluateOverride(loaders, route, searchParamsOf(req))
    if (override) {
      return respond(override.content, "text/markdown")
    }

    const html = await fetchPage(origin, route, req.headers.get("cookie"))
    if (html === null) {
      return notFound()
    }
    return respond(
      convert(html, CONVERT_OPTIONS).content ?? "",
      "text/markdown"
    )
  }
}

// Static patterns win over dynamic ones ("/tags/list" beats "/tags/[tag]").
async function evaluateOverride(
  loaders: Loaders,
  route: string,
  searchParams: Record<string, string | string[]>
): Promise<ResolvedMd | null> {
  const patterns = Object.keys(loaders).sort(
    (a, b) => Number(a.includes("[")) - Number(b.includes("["))
  )
  for (const pattern of patterns) {
    const params = matchPattern(route, pattern)
    if (!params) {
      continue
    }
    try {
      const mod = (await loaders[pattern]()) as { md?: unknown }
      const value = await evaluateMd(mod.md, params, searchParams)
      if (value) {
        return value
      }
    } catch {
      // a page module that fails to load falls back to HTML conversion
    }
  }
  return null
}

async function serveSurface(
  kind: "llms.txt" | "llms-full.txt",
  origin: string,
  options: RouteOptions,
  loaders: Loaders
): Promise<Response> {
  const routes = discoverRoutes(options.dev).filter((route) =>
    matchesRoute(route, options)
  )
  // unauthenticated fetches: pages that redirect or fail (auth guards) drop out
  const pages = (
    await Promise.all(
      routes.map(async (route): Promise<ServedPage | null> => {
        const html = await fetchPage(origin, route, null)
        if (html === null) {
          return null
        }
        const result = convert(html, CONVERT_OPTIONS)
        const rendered = pageMeta(result.metadata)
        const override = await evaluateOverride(loaders, route, {})
        return {
          content: override?.content ?? result.content ?? "",
          meta: {
            description: override?.description ?? rendered.description,
            title: override?.title ?? rendered.title,
          },
          rendered,
          route,
        }
      })
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
  const sections = orderLinks(links).map((link) =>
    stripFrontmatter(byRoute.get(link.route)?.content ?? "").trim()
  )
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
  const appDir = existsSync(srcApp)
    ? srcApp
    : existsSync(plainApp)
      ? plainApp
      : null
  if (!appDir) {
    return []
  }
  const routes: string[] = []
  walk(appDir, "")
  return routes.sort()

  function walk(current: string, route: string): void {
    const entries = readdirSync(current, { withFileTypes: true })
    if (
      entries.some(
        (e) => e.isFile() && /^page\.(tsx|jsx|ts|js|mdx)$/.test(e.name)
      )
    ) {
      routes.push(route === "" ? "/" : route)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const name = entry.name
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
    : pageMeta(convert(html, CONVERT_OPTIONS).metadata)
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
  const searchParams = new URL(req.url).searchParams
  const result: Record<string, string | string[]> = {}
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key)
    result[key] = values.length > 1 ? values : values[0]
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

function respond(body: string, type: "text/markdown" | "text/plain"): Response {
  return new Response(body, {
    headers: { "content-type": `${type}; charset=utf-8` },
  })
}

function notFound(): Response {
  return new Response("Not found", { status: 404 })
}
