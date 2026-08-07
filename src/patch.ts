// Child of the withText build-exit hook (spawnSync'd so it may await freely).
// Walks the built HTML in .next/server/app — the build output IS the route
// list, so auth-gated dynamic pages are absent by construction — and writes
// the static surfaces into public/.

import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { convert } from "@xberg-io/html-to-markdown"
import {
  CONVERT_OPTIONS,
  discoverBuiltRoutes,
  evaluateMd,
  type Link,
  type LlmstxtContext,
  linkHref,
  matchesRoute,
  orderLinks,
  type PageMeta,
  pageMeta,
  type ResolvedMd,
  type ResolvedOptions,
  readProxyMatchers,
  renderFull,
  renderIndex,
  stripFrontmatter,
} from "./shared"

const MANIFEST = "next-with-text-manifest.json"

interface Payload {
  dir: string
  hasLlmstxt: boolean
  options: ResolvedOptions
}
interface Page {
  content: string
  meta: PageMeta
  rendered: PageMeta
  route: string
}

const payload = JSON.parse(process.argv[2] ?? "{}") as Payload

main(payload).catch((err) => {
  console.error("[next-with-text] generation failed:", err)
})

async function main({ dir, options, hasLlmstxt }: Payload): Promise<void> {
  const serverApp = join(dir, ".next", "server", "app")
  if (!(existsSync(join(dir, ".next", "BUILD_ID")) && existsSync(serverApp))) {
    return
  }

  const proxyMatchers = readProxyMatchers(dir)
  const routes = (discoverBuiltRoutes(dir) ?? [])
    .filter((route) => matchesRoute(route, options))
    .filter((route) => !proxyMatchers.some((re) => re.test(route)))

  const pages: Page[] = []
  for (const route of routes) {
    const html = readFileSync(
      join(serverApp, route === "/" ? "index.html" : `${route.slice(1)}.html`),
      "utf8"
    )
    const result = convert(html, CONVERT_OPTIONS)
    const rendered = pageMeta(result.metadata)
    const override = await pageOverride(serverApp, route)
    pages.push({
      content: override?.content ?? result.content ?? "",
      // object-form md exports curate the page's index entry; string form
      // keeps the rendered metadata
      meta: {
        description: override?.description ?? rendered.description,
        title: override?.title ?? rendered.title,
      },
      rendered,
      route,
    })
  }

  const site = pages.find((page) => page.route === "/")?.rendered ?? {
    description: "",
    title: "",
  }
  const links: Link[] = pages.map((page) => ({
    route: page.route,
    ...page.meta,
  }))
  const byRoute = new Map(pages.map((page) => [page.route, page]))
  const writes: [rel: string, content: string][] = []

  if (options.md) {
    for (const page of pages) {
      const rel = page.route === "/" ? "index.md" : `${page.route.slice(1)}.md`
      writes.push([
        rel,
        page.content.endsWith("\n") ? page.content : `${page.content}\n`,
      ])
    }
  }

  // the llmstxt function can't cross into this process as JSON — re-load the
  // user's next config (capture mode) to reach it; its return IS the file body
  const llmstxt = hasLlmstxt ? await loadLlmstxt(dir) : undefined
  writes.push([
    "llms.txt",
    llmstxt
      ? llmstxt({
          description: site.description,
          routes: orderLinks(links).map((link) => ({
            description: link.description,
            href: linkHref(link.route, options.md),
            title: link.title,
          })),
          title: site.title,
        })
      : renderIndex(site, links, options.md),
  ])
  writes.push([
    "llms-full.txt",
    renderFull(
      site,
      orderLinks(links).map((link) =>
        stripFrontmatter(byRoute.get(link.route)?.content ?? "").trim()
      )
    ),
  ])

  const publicDir = join(dir, "public")
  // The public/ tier is a deploy artifact: local builds skip it (the on-demand
  // route serves everything under next start) so the working tree stays clean,
  // and prune() below removes leftovers from an earlier deploy-shaped build.
  const emitStatic = staticTierEnabled(process.env)
  // standalone output copies public/ during the build, before this hook runs —
  // mirror the writes so the copied tree matches (it lives inside .next, so
  // it's written regardless of the deploy gate)
  const standalonePublic = join(dir, ".next", "standalone", "public")
  const written: Record<string, string> = {}
  for (const [rel, content] of writes) {
    const targets = [
      ...(emitStatic ? [publicDir] : []),
      ...(existsSync(standalonePublic) ? [standalonePublic] : []),
    ]
    for (const base of targets) {
      const target = join(base, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    if (emitStatic) {
      written[rel] = hashOf(content)
    }
  }

  prune(dir, publicDir, written)
  console.log(
    emitStatic
      ? `[next-with-text] generated ${Object.keys(written).length} file(s) into public/`
      : "[next-with-text] local build — public/ untouched; llms surfaces serve on demand (set NEXT_WITH_TEXT_STATIC=1 to write them)"
  )
}

// Deploy detection: VERCEL/CI mark a build whose output ships somewhere;
// NEXT_WITH_TEXT_STATIC overrides in either direction (self-hosters building
// outside CI set it to 1).
function staticTierEnabled(env: NodeJS.ProcessEnv): boolean {
  const truthy = (value: string | undefined) =>
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  const override = env.NEXT_WITH_TEXT_STATIC
  if (override !== undefined && override !== "") {
    return truthy(override)
  }
  return truthy(env.VERCEL) || truthy(env.CI)
}

// Pages may `export const md` (plain value, sync or async function); the export
// survives bundling into .next/server/app/<pattern>/page.js. Loading that
// module needs the ALS global Next's shim expects, then a walk of the
// loaderTree to the __PAGE__ leaf's module loader. Each generateStaticParams
// instance resolves to the same module with its own captured params.
async function pageOverride(
  serverApp: string,
  route: string
): Promise<ResolvedMd | null> {
  const located = locatePageModule(serverApp, route)
  if (!located) {
    return null
  }
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
  route: string
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
        !entry.name.startsWith("[...")
    )
    if (!dynamic) {
      return null
    }
    params[dynamic.name.slice(1, -1)] = segment
    dir = join(dir, dynamic.name)
  }
  const pageJs = join(dir, "page.js")
  return existsSync(pageJs) ? { pageJs, params } : null
}

// Re-runs the user's next config through Next's own loader (which handles TS
// transpilation) with the capture global set: withText sees it, hands over the
// llmstxt function, and skips all side effects in that pass.
async function loadLlmstxt(
  dir: string
): Promise<((ctx: LlmstxtContext) => string) | undefined> {
  const capture: { llmstxt?: unknown } = {}
  ;(globalThis as Record<string, unknown>).__NEXT_WITH_TEXT_CAPTURE__ = capture
  try {
    const requireFrom = createRequire(join(dir, "package.json"))
    const configModule = requireFrom("next/dist/server/config") as {
      default?: unknown
    }
    const loadConfig = (configModule.default ?? configModule) as (
      phase: string,
      dir: string
    ) => Promise<unknown>
    await loadConfig("phase-production-build", dir)
    return typeof capture.llmstxt === "function"
      ? (capture.llmstxt as (ctx: LlmstxtContext) => string)
      : undefined
  } catch (err) {
    console.error(
      "[next-with-text] failed to load the llmstxt function from next.config:",
      err
    )
  } finally {
    ;(globalThis as Record<string, unknown>).__NEXT_WITH_TEXT_CAPTURE__ =
      undefined
  }
}

// Outputs the last run wrote are tracked in a manifest of path → content
// hash, so a rebuild can reclaim files no longer generated (a deleted page's
// .md, or everything at once when a local build skips the static tier). The
// hash is the ownership proof: a file the user has since edited by hand no
// longer matches and is left alone. The manifest lives in .next/cache — never
// public/, so it ships nowhere, and cache/ is the one part of .next that
// next build preserves across builds.
function prune(
  dir: string,
  publicDir: string,
  written: Record<string, string>
): void {
  const manifestPath = join(dir, ".next", "cache", MANIFEST)
  try {
    const previous = readManifest(manifestPath)
    for (const [rel, hash] of Object.entries(previous)) {
      if (rel in written) {
        continue
      }
      const target = join(publicDir, rel)
      if (existsSync(target) && hashOf(readFileSync(target, "utf8")) === hash) {
        rmSync(target, { force: true })
        removeEmptyParents(publicDir, dirname(target))
      }
    }
  } catch {
    // a corrupt manifest just skips pruning for one build
  }
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(written, null, 2))
}

// A pruned .md can leave behind the directory the build made for it (public/
// tags/, public/blog/…) — walk back up while the folders are empty, stopping
// at public/ itself and at anything the user still has files in. rmdirSync is
// non-recursive, so a non-empty directory simply refuses.
function removeEmptyParents(publicDir: string, from: string): void {
  let current = from
  while (current.startsWith(publicDir) && current !== publicDir) {
    try {
      rmdirSync(current)
    } catch {
      return
    }
    current = dirname(current)
  }
}

function readManifest(manifestPath: string): Record<string, string> {
  if (!existsSync(manifestPath)) {
    return {}
  }
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {}
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}
