// Child of the withText build-exit hook (spawnSync'd so it may await freely).
// Walks the built HTML in .next/server/app — the build output IS the route
// list, so auth-gated dynamic pages are absent by construction — and writes
// the static surfaces into public/.

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
import {
  generatedManifest,
  hashOf,
  userAppRoutes,
  userPublicFile,
} from "./ownership.js"
import {
  compareCodeUnits,
  convertHTML,
  discoverBuiltRoutes,
  discoverModuleRoutes,
  evaluateMd,
  type Link,
  type LlmsFulltxtContext,
  type LlmstxtContext,
  llmsfulltxtSections,
  llmstxtSections,
  matchesRoute,
  orderLinks,
  type PageMeta,
  pageMeta,
  publishedBody,
  type ResolvedMd,
  type ResolvedOptions,
  readProxyMatchers,
  renderFull,
  renderIndex,
  renderStub,
  stripFrontmatter,
} from "./shared.js"

const MANIFEST = "next-with-text-manifest.json"

type Payload = {
  dir: string
  hasLlmsfulltxt: boolean
  hasLlmstxt: boolean
  options: ResolvedOptions
}
type Page = {
  // null when the page publishes no body: nothing to write as a .md twin, and
  // a stub rather than an inlined section in llms-full.txt
  content: string | null
  meta: PageMeta
  rendered: PageMeta
  route: string
}

const payload = JSON.parse(process.argv[2] ?? "{}") as Payload

main(payload).catch((err) => {
  console.error("[next-with-text] generation failed:", err)
})

async function main({
  dir,
  options,
  hasLlmsfulltxt,
  hasLlmstxt,
}: Payload): Promise<void> {
  const serverApp = join(dir, ".next", "server", "app")
  if (!(existsSync(join(dir, ".next", "BUILD_ID")) && existsSync(serverApp))) {
    return
  }

  const proxyMatchers = readProxyMatchers(dir)
  const prerendered = new Set(discoverBuiltRoutes(dir) ?? [])
  // A route is gated when the build prerendered no HTML for it (it read
  // cookies/headers, or redirected) or a proxy matcher guards it. Gated routes
  // publish nothing at all unless the page opts in with a titled md export —
  // and even then only what that export declares, never rendered output.
  const gatedRoute = (route: string) =>
    !prerendered.has(route) || proxyMatchers.some((re) => re.test(route))
  const routes = [...new Set([...prerendered, ...discoverModuleRoutes(dir)])]
    .filter((route) => matchesRoute(route, options))
    .sort(compareCodeUnits)

  const appRoutes = userAppRoutes(dir)
  const manifest = generatedManifest(dir)
  const ownedByUser = (rel: string) =>
    appRoutes.has(rel) || userPublicFile(dir, rel, manifest)
  const needsIndex = !ownedByUser("llms.txt")
  const needsFull = !ownedByUser("llms-full.txt")
  let routesToBuild = routes
  if (!(needsIndex || needsFull)) {
    routesToBuild = options.md
      ? routes.filter(
          (route) =>
            !ownedByUser(route === "/" ? "index.md" : `${route.slice(1)}.md`)
        )
      : []
  }

  const publicDir = join(dir, "public")
  if (!(needsIndex || needsFull) && routesToBuild.length === 0) {
    prune(dir, publicDir, {})
    console.log("[next-with-text] existing routes own every enabled surface")
    return
  }
  const builtPages = await Promise.all(
    routesToBuild.map((route) => buildPage(serverApp, route, gatedRoute(route)))
  )
  const pages = builtPages.filter((page): page is Page => page !== null)
  const optedIn = pages
    .filter((page) => gatedRoute(page.route))
    .map((page) => page.route)
  if (optedIn.length > 0) {
    // the one way a route Next kept off the static surfaces gets published —
    // say so by name, so it can never happen quietly
    console.log(
      `[next-with-text] ${optedIn.length} gated route(s) opted into the index via md export: ${optedIn.join(", ")}`
    )
  }

  const site = pages.find((page) => page.route === "/")?.rendered ?? {
    description: "",
    title: "",
  }
  const links: Link[] = pages.map((page) => ({
    route: page.route,
    ...page.meta,
  }))
  const writes = await buildWrites(
    dir,
    options,
    hasLlmsfulltxt,
    hasLlmstxt,
    pages,
    site,
    links,
    ownedByUser
  )

  // The public/ tier is a deploy artifact: local builds skip it (the on-demand
  // route serves everything under next start) so the working tree stays clean,
  // and prune() below removes leftovers from an earlier deploy-shaped build.
  const emitStatic = staticTierEnabled(process.env)
  // standalone output copies public/ during the build, before this hook runs —
  // mirror the writes so the copied tree matches (it lives inside .next, so
  // it's written regardless of the deploy gate)
  const standalonePublic = join(dir, ".next", "standalone", "public")
  const targets = [
    ...(emitStatic ? [publicDir] : []),
    ...(existsSync(standalonePublic) ? [standalonePublic] : []),
  ]
  const written = writeOutputs(writes, targets, emitStatic)

  reclaimShadowed(
    [publicDir, ...(existsSync(standalonePublic) ? [standalonePublic] : [])],
    pages,
    options.md,
    ownedByUser
  )
  prune(dir, publicDir, written)
  console.log(
    emitStatic
      ? `[next-with-text] generated ${Object.keys(written).length} file(s) into public/`
      : "[next-with-text] local build — public/ untouched; llms surfaces serve on demand (set NEXT_WITH_TEXT_STATIC=1 to write them)"
  )
}

async function buildWrites(
  dir: string,
  options: ResolvedOptions,
  hasLlmsfulltxt: boolean,
  hasLlmstxt: boolean,
  pages: Page[],
  site: PageMeta,
  links: Link[],
  ownedByUser: (rel: string) => boolean
): Promise<[rel: string, content: string][]> {
  const writes: [rel: string, content: string][] = options.md
    ? pages.flatMap((page) => {
        if (page.content === null) {
          return []
        }
        const rel =
          page.route === "/" ? "index.md" : `${page.route.slice(1)}.md`
        if (ownedByUser(rel)) {
          return []
        }
        const content = page.content.endsWith("\n")
          ? page.content
          : `${page.content}\n`
        return [[rel, content]]
      })
    : []
  // Functions can't cross into this process as JSON — re-load the user's next
  // config in capture mode to reach them; each return IS its entire file body.
  const renderLlmstxt = !ownedByUser("llms.txt")
  const renderLlmsfulltxt = !ownedByUser("llms-full.txt")
  const templates =
    (renderLlmstxt && hasLlmstxt) || (renderLlmsfulltxt && hasLlmsfulltxt)
      ? await loadTemplates(dir)
      : {}
  if (renderLlmstxt) {
    writes.push([
      "llms.txt",
      templates.llmstxt
        ? templates.llmstxt({
            description: site.description,
            sections: llmstxtSections(links, options.md),
            title: site.title,
          })
        : renderIndex(site, links, options.md),
    ])
  }
  const byRoute = new Map(pages.map((page) => [page.route, page]))
  const content = (link: Link) => {
    const pageContent = byRoute.get(link.route)?.content
    const rel = link.route === "/" ? "index.md" : `${link.route.slice(1)}.md`
    if (ownedByUser(rel)) {
      return renderExistingMarkdown(link)
    }
    return pageContent === null || pageContent === undefined
      ? renderStub(link, options.md)
      : stripFrontmatter(pageContent).trim()
  }
  if (renderLlmsfulltxt) {
    writes.push([
      "llms-full.txt",
      templates.llmsfulltxt
        ? templates.llmsfulltxt({
            description: site.description,
            sections: llmsfulltxtSections(links, options.md, content),
            title: site.title,
          })
        : renderFull(site, orderLinks(links).map(content)),
    ])
  }
  return writes
}

function renderExistingMarkdown(link: Link): string {
  const parts = [`# ${link.title}`.trimEnd()]
  if (link.description) {
    parts.push(`> ${link.description}`)
  }
  const href = link.route === "/" ? "/index.md" : `${link.route}.md`
  parts.push(`[Read markdown](${href})`)
  return parts.join("\n\n")
}

function writeOutputs(
  writes: [rel: string, content: string][],
  targets: string[],
  trackHashes: boolean
): Record<string, string> {
  const written: Record<string, string> = {}
  for (const [rel, content] of writes) {
    for (const base of targets) {
      const target = join(base, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    if (trackHashes) {
      written[rel] = hashOf(content)
    }
  }
  return written
}

async function buildPage(
  serverApp: string,
  route: string,
  gated: boolean
): Promise<Page | null> {
  const override = await pageOverride(serverApp, route)
  if (gated && !override?.title) {
    return null
  }
  const result = gated
    ? null
    : await convertHTML(readFileSync(htmlPath(serverApp, route), "utf8"))
  const rendered = result
    ? pageMeta(result.metadata)
    : { description: "", title: "" }
  return {
    content: publishedBody(override, result?.content),
    // object-form md exports curate the page's index entry; string form keeps
    // the rendered metadata
    meta: {
      description: override?.description ?? rendered.description,
      title: override?.title ?? rendered.title,
    },
    rendered,
    route,
  }
}

// A route that publishes no body must never be shadowed by a file left at its
// path — that would serve a captured render where the live, per-requester one
// belongs. Unlike prune() this ignores the manifest and the content hash: the
// file cannot be allowed to stay whatever its provenance.
function reclaimShadowed(
  bases: string[],
  pages: Page[],
  mdEnabled: boolean,
  ownedByUser: (rel: string) => boolean
): void {
  if (!mdEnabled) {
    return
  }
  for (const page of pages) {
    if (page.content !== null) {
      continue
    }
    const rel = page.route === "/" ? "index.md" : `${page.route.slice(1)}.md`
    if (ownedByUser(rel)) {
      continue
    }
    let removed = false
    for (const base of bases) {
      const target = join(base, rel)
      if (!existsSync(target)) {
        continue
      }
      rmSync(target, { force: true })
      removeEmptyParents(base, dirname(target))
      removed = true
    }
    if (removed) {
      console.log(
        `[next-with-text] removed public/${rel}: ${page.route} publishes no body, so it must serve live`
      )
    }
  }
}

function htmlPath(serverApp: string, route: string): string {
  return join(
    serverApp,
    route === "/" ? "index.html" : `${route.slice(1)}.html`
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
    const { routeModule } = require(located.pageJs) as CompiledPageModule
    const loader = findPageLoader(routeModule?.userland?.loaderTree)
    if (loader) {
      const userland = await loader()
      // static output can't depend on the query string — searchParams is {}
      return await evaluateMd(userland.md, located.params, {})
    }
  } catch {
    // pages that can't load outside the server runtime fall back to HTML conversion
  }
  return null
}

type PageLoader = () => Promise<{ md?: unknown }>
type LoaderTree = [
  segment: string,
  parallelRoutes: { children?: LoaderTree },
  modules: { page?: [PageLoader, ...unknown[]] },
]
type CompiledPageModule = {
  routeModule?: { userland?: { loaderTree?: LoaderTree } }
}

function findPageLoader(tree: LoaderTree | undefined): PageLoader | undefined {
  let node = tree
  while (node) {
    const [segment, parallelRoutes, modules] = node
    if (segment === "__PAGE__") {
      return modules.page?.[0]
    }
    node = parallelRoutes.children
  }
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
// template functions, and skips all side effects in that pass.
type Templates = {
  llmsfulltxt?: (ctx: LlmsFulltxtContext) => string
  llmstxt?: (ctx: LlmstxtContext) => string
}

async function loadTemplates(dir: string): Promise<Templates> {
  const capture: { llmsfulltxt?: unknown; llmstxt?: unknown } = {}
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
    return {
      llmsfulltxt:
        typeof capture.llmsfulltxt === "function"
          ? (capture.llmsfulltxt as (ctx: LlmsFulltxtContext) => string)
          : undefined,
      llmstxt:
        typeof capture.llmstxt === "function"
          ? (capture.llmstxt as (ctx: LlmstxtContext) => string)
          : undefined,
    }
  } catch (err) {
    console.error(
      "[next-with-text] failed to load template functions from next.config:",
      err
    )
    return {}
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
    const previous = generatedManifest(dir)
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
