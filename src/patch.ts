// Child of the withText build-exit hook (spawnSync'd so it may await freely).
// Walks the built HTML in .next/server/app — the build output IS the route
// list, so auth-gated dynamic pages are absent by construction — and writes
// the static surfaces into public/.
import { convert } from "@xberg-io/html-to-markdown"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, sep } from "node:path"
import {
  CONVERT_OPTIONS,
  evaluateMd,
  linkHref,
  matchesRoute,
  orderLinks,
  pageMeta,
  renderFull,
  renderIndex,
  stripFrontmatter,
  type Link,
  type LlmstxtContext,
  type PageMeta,
  type ResolvedMd,
  type ResolvedOptions,
} from "./shared"

const MANIFEST = "next-with-text-manifest.json"

type Payload = { dir: string; options: ResolvedOptions; hasLlmstxt: boolean }
type Page = { route: string; rendered: PageMeta; meta: PageMeta; content: string }

const payload = JSON.parse(process.argv[2] ?? "{}") as Payload

main(payload).catch((err) => {
  console.error("[next-with-text] generation failed:", err)
})

async function main({ dir, options, hasLlmstxt }: Payload): Promise<void> {
  const serverApp = join(dir, ".next", "server", "app")
  if (!existsSync(join(dir, ".next", "BUILD_ID")) || !existsSync(serverApp)) return

  const proxyMatchers = readProxyMatchers(join(dir, ".next", "server", "functions-config-manifest.json"))
  const routes = discoverBuiltRoutes(serverApp)
    .filter((route) => matchesRoute(route, options))
    .filter((route) => !proxyMatchers.some((re) => re.test(route)))
    .sort()

  const pages: Page[] = []
  for (const route of routes) {
    const html = readFileSync(join(serverApp, route === "/" ? "index.html" : `${route.slice(1)}.html`), "utf8")
    const result = convert(html, CONVERT_OPTIONS)
    const rendered = pageMeta(result.metadata)
    const override = await pageOverride(serverApp, route)
    pages.push({
      route,
      rendered,
      // object-form md exports curate the page's index entry; string form
      // keeps the rendered metadata
      meta: {
        title: override?.title ?? rendered.title,
        description: override?.description ?? rendered.description,
      },
      content: override?.content ?? result.content ?? "",
    })
  }

  const site = pages.find((page) => page.route === "/")?.rendered ?? { title: "", description: "" }
  const links: Link[] = pages.map((page) => ({ route: page.route, ...page.meta }))
  const byRoute = new Map(pages.map((page) => [page.route, page]))
  const writes: Array<[rel: string, content: string]> = []

  if (options.md) {
    for (const page of pages) {
      const rel = page.route === "/" ? "index.md" : `${page.route.slice(1)}.md`
      writes.push([rel, page.content.endsWith("\n") ? page.content : `${page.content}\n`])
    }
  }

  // the llmstxt function can't cross into this process as JSON — re-load the
  // user's next config (capture mode) to reach it; its return IS the file body
  const llmstxt = hasLlmstxt ? await loadLlmstxt(dir) : undefined
  writes.push([
    "llms.txt",
    llmstxt
      ? llmstxt({
          title: site.title,
          description: site.description,
          routes: orderLinks(links).map((link) => ({
            title: link.title,
            description: link.description,
            href: linkHref(link.route, options.md),
          })),
        })
      : renderIndex(site, links, options.md),
  ])
  writes.push([
    "llms-full.txt",
    renderFull(
      site,
      orderLinks(links).map((link) => stripFrontmatter(byRoute.get(link.route)?.content ?? "").trim()),
    ),
  ])

  const publicDir = join(dir, "public")
  // standalone output copies public/ during the build, before this hook runs —
  // mirror the writes so the copied tree matches
  const standalonePublic = join(dir, ".next", "standalone", "public")
  const written: string[] = []
  for (const [rel, content] of writes) {
    for (const base of [publicDir, ...(existsSync(standalonePublic) ? [standalonePublic] : [])]) {
      const target = join(base, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    written.push(rel)
  }

  prune(dir, publicDir, written)
  console.log(`[next-with-text] generated ${written.length} file(s) into public/`)
}

function discoverBuiltRoutes(serverApp: string): string[] {
  const routes: string[] = []
  walk(serverApp)
  return routes

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name
      if (name.startsWith("_") || name.startsWith("%5F")) continue
      if (entry.isDirectory()) {
        walk(join(dir, name))
        continue
      }
      if (!name.endsWith(".html")) continue
      const rel = relative(serverApp, join(dir, name)).slice(0, -".html".length)
      if (rel === "404" || rel === "500") continue
      routes.push(rel === "index" ? "/" : `/${rel.split(sep).join("/")}`)
    }
  }
}

// Next 16 exposes proxy.ts matchers (compiled regexp + originalSource) in
// functions-config-manifest.json — middleware-manifest.json stays empty.
// Proxy-guarded routes are excluded from every static surface by default.
function readProxyMatchers(manifestPath: string): RegExp[] {
  if (!existsSync(manifestPath)) return []
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      functions?: Record<string, { matchers?: Array<{ regexp: string }> }>
    }
    return Object.values(manifest.functions ?? {})
      .flatMap((fn) => fn.matchers ?? [])
      .map((matcher) => new RegExp(matcher.regexp))
  } catch {
    return []
  }
}

// Pages may `export const md` (plain value, sync or async function); the export
// survives bundling into .next/server/app/<pattern>/page.js. Loading that
// module needs the ALS global Next's shim expects, then a walk of the
// loaderTree to the __PAGE__ leaf's module loader. Each generateStaticParams
// instance resolves to the same module with its own captured params.
async function pageOverride(serverApp: string, route: string): Promise<ResolvedMd | null> {
  const located = locatePageModule(serverApp, route)
  if (!located) return null
  ;(globalThis as Record<string, unknown>).AsyncLocalStorage ??=
    require("node:async_hooks").AsyncLocalStorage
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routeModule = (require(located.pageJs) as any).routeModule
    let node = routeModule?.userland?.loaderTree
    while (node) {
      const [segment, parallelRoutes, mods] = node
      if (segment === "__PAGE__") {
        const userland = await mods.page[0]()
        // static output can't depend on the query string — searchParams is {}
        return await evaluateMd(userland.md, located.params, {})
      }
      node = parallelRoutes?.children
    }
  } catch {
    // pages that can't load outside the server runtime fall back to HTML conversion
  }
  return null
}

// Maps a concrete route to its compiled page module, resolving [param]
// directories and collecting what they capture (/tags/alpha →
// tags/[tag]/page.js with { tag: "alpha" }).
function locatePageModule(
  serverApp: string,
  route: string,
): { pageJs: string; params: Record<string, string> } | null {
  let dir = serverApp
  const params: Record<string, string> = {}
  for (const segment of route.split("/").filter(Boolean)) {
    if (existsSync(join(dir, segment))) {
      dir = join(dir, segment)
      continue
    }
    const dynamic = readdirSync(dir, { withFileTypes: true }).find(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("[") &&
        entry.name.endsWith("]") &&
        !entry.name.startsWith("[..."),
    )
    if (!dynamic) return null
    params[dynamic.name.slice(1, -1)] = segment
    dir = join(dir, dynamic.name)
  }
  const pageJs = join(dir, "page.js")
  return existsSync(pageJs) ? { pageJs, params } : null
}

// Re-runs the user's next config through Next's own loader (which handles TS
// transpilation) with the capture global set: withText sees it, hands over the
// llmstxt function, and skips all side effects in that pass.
async function loadLlmstxt(dir: string): Promise<((ctx: LlmstxtContext) => string) | undefined> {
  const capture: { llmstxt?: unknown } = {}
  ;(globalThis as Record<string, unknown>).__NEXT_WITH_TEXT_CAPTURE__ = capture
  try {
    const requireFrom = createRequire(join(dir, "package.json"))
    const configModule = requireFrom("next/dist/server/config") as { default?: unknown }
    const loadConfig = (configModule.default ?? configModule) as (
      phase: string,
      dir: string,
    ) => Promise<unknown>
    await loadConfig("phase-production-build", dir)
    return typeof capture.llmstxt === "function"
      ? (capture.llmstxt as (ctx: LlmstxtContext) => string)
      : undefined
  } catch (err) {
    console.error("[next-with-text] failed to load the llmstxt function from next.config:", err)
    return undefined
  } finally {
    delete (globalThis as Record<string, unknown>).__NEXT_WITH_TEXT_CAPTURE__
  }
}

// Stale outputs from removed pages are pruned via a manifest of what the last
// run wrote. It lives in .next/cache (never public/, so it ships nowhere) —
// cache/ is the one part of .next that next build preserves across builds.
function prune(dir: string, publicDir: string, written: string[]): void {
  const manifestPath = join(dir, ".next", "cache", MANIFEST)
  try {
    const previous = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as string[])
      : []
    for (const rel of previous) {
      if (!written.includes(rel)) rmSync(join(publicDir, rel), { force: true })
    }
  } catch {
    // a corrupt manifest just skips pruning for one build
  }
  writeFileSync(manifestPath, JSON.stringify(written, null, 2))
}
