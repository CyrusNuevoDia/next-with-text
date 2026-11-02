// Generation runs only from Next’s adapter completion hook. Its normalized
// context names each artifact; no build directory discovery is needed here.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type {
  BuildContext,
  BuildPayload,
  CompiledPage,
} from "./build-context.js"
import {
  generatedManifest,
  hashOf,
  userAppRoutes,
  userPublicFile,
} from "./ownership.js"
import {
  compareCodeUnits,
  convertHTMLtoMarkdown,
  evaluateMd,
  type Link,
  type LlmsFulltxtContext,
  type LlmstxtContext,
  llmsfulltxtSections,
  llmstxtSections,
  matchesRoute,
  matchPattern,
  orderLinks,
  type PageMeta,
  pageMeta,
  publishedBody,
  type ResolvedMd,
  type ResolvedOptions,
  renderFull,
  renderIndex,
  renderStub,
  stripFrontmatter,
} from "./shared.js"

const MANIFEST = "next-with-text-manifest.json"

type Page = {
  // null when the page publishes no body: nothing to write as a .md twin, and
  // a stub rather than an inlined section in llms-full.txt
  content: string | null
  meta: PageMeta
  rendered: PageMeta
  route: string
}

const [, , payloadJSON, contextFile] = process.argv
Promise.resolve()
  .then(() => {
    if (!(payloadJSON && contextFile)) {
      throw new Error(
        "[next-with-text] generation requires adapter build context"
      )
    }
    return main(
      JSON.parse(payloadJSON) as BuildPayload,
      JSON.parse(readFileSync(contextFile, "utf8")) as BuildContext
    )
  })
  .catch((err) => {
    console.error("[next-with-text] generation failed:", err)
    process.exitCode = 1
  })

async function main(
  { options, hasLlmsfulltxt, hasLlmstxt }: BuildPayload,
  context: BuildContext
): Promise<void> {
  const { projectDir: dir, distDir, prerenderedHTML } = context
  const proxyMatchers = context.proxyMatchers.map(
    (source) => new RegExp(source)
  )
  const prerendered = new Set(Object.keys(prerenderedHTML))
  // A route is gated when the build prerendered no HTML for it (it read
  // cookies/headers, or redirected) or a proxy matcher guards it. Gated routes
  // publish nothing at all unless the page opts in with a titled md export —
  // and even then only what that export declares, never rendered output.
  const gatedRoute = (route: string) =>
    !prerendered.has(route) ||
    proxyMatchers.some((re) =>
      re.test(`${context.basePath}${route === "/" ? "" : route}` || "/")
    )
  const literalPages = context.pages
    .map((page) => page.pattern)
    .filter((route) => !route.includes("["))
  const routes = [...new Set([...prerendered, ...literalPages])]
    .filter((route) => matchesRoute(route, options))
    .sort(compareCodeUnits)

  const appRoutes = userAppRoutes(dir)
  const manifest = generatedManifest(dir, distDir)
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

  // Next recreates standalone after this hook. Stage its public tier outside
  // that tree; the adapter copies it after Next finishes, without regenerating.
  const standalonePublic = context.standaloneDir
    ? join(distDir, "cache", "next-with-text-standalone")
    : undefined
  if (standalonePublic) {
    rmSync(standalonePublic, { force: true, recursive: true })
    mkdirSync(standalonePublic, { recursive: true })
  }

  const publicDir = join(dir, "public")
  if (!(needsIndex || needsFull) && routesToBuild.length === 0) {
    cacheRoutes()
    prune(dir, distDir, publicDir, {})
    console.log("[next-with-text] existing routes own every enabled surface")
    return
  }
  const builtPages = await Promise.all(
    routesToBuild.map((route) =>
      buildPage(
        context.pages,
        route,
        gatedRoute(route) ? null : (prerenderedHTML[route] ?? null)
      )
    )
  )
  const pages = builtPages.filter((page): page is Page => page !== null)
  // An empty index deploys as silently as a full one — say so in the log.
  if (prerendered.size === 0) {
    console.warn(
      "[next-with-text] the build prerendered no HTML — llms.txt and llms-full.txt carry only md opt-ins"
    )
  } else if (pages.length === 0) {
    console.warn(
      "[next-with-text] no page survived include/exclude — llms.txt and llms-full.txt are empty"
    )
  }
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
  const targets = [
    ...(emitStatic ? [publicDir] : []),
    ...(standalonePublic ? [standalonePublic] : []),
  ]
  const written = writeOutputs(writes, targets, emitStatic)
  cacheRoutes()

  reclaimShadowed(
    [publicDir, ...(standalonePublic ? [standalonePublic] : [])],
    pages,
    options.md,
    ownedByUser
  )
  prune(dir, distDir, publicDir, written)
  console.log(
    emitStatic
      ? `[next-with-text] generated ${Object.keys(written).length} file(s) into public/`
      : "[next-with-text] local build — public/ untouched; llms surfaces serve on demand (set NEXT_WITH_TEXT_STATIC=1 to write them)"
  )

  function cacheRoutes(): void {
    const cache = join(distDir, "cache")
    mkdirSync(cache, { recursive: true })
    writeFileSync(
      join(cache, "next-with-text-routes.json"),
      JSON.stringify(
        [...prerendered]
          .filter((route) => !gatedRoute(route))
          .sort(compareCodeUnits)
      )
    )
  }
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
  if (renderLlmstxt && hasLlmstxt && !templates.llmstxt) {
    throw new Error("[next-with-text] could not recover the llmstxt callback")
  }
  if (renderLlmsfulltxt && hasLlmsfulltxt && !templates.llmsfulltxt) {
    throw new Error(
      "[next-with-text] could not recover the llmsfulltxt callback"
    )
  }
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

// html is null for a gated route: nothing rendered may be read for it.
async function buildPage(
  modules: CompiledPage[],
  route: string,
  html: string | null
): Promise<Page | null> {
  const override = await pageOverride(modules, route)
  if (html === null && !override?.title) {
    return null
  }
  const result =
    html === null
      ? null
      : await convertHTMLtoMarkdown(readFileSync(html, "utf8"))
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
  modules: CompiledPage[],
  route: string
): Promise<ResolvedMd | null> {
  const located = modules
    .toSorted(
      (a, b) =>
        Number(a.pattern.includes("[")) - Number(b.pattern.includes("["))
    )
    .map((page) => ({ page, params: matchPattern(route, page.pattern) }))
    .find((candidate) => candidate.params !== null)
  if (!located?.params) {
    return null
  }
  ;(globalThis as Record<string, unknown>).AsyncLocalStorage ??=
    require("node:async_hooks").AsyncLocalStorage
  let userland: { md?: unknown } | undefined
  try {
    const { routeModule } = require(located.page.filePath) as CompiledPageModule
    const loader = findPageLoader(routeModule?.userland?.loaderTree)
    if (loader) {
      userland = await loader()
    }
  } catch {
    // Some page modules need the server runtime; ordinary pages can still
    // publish their prerendered HTML when their module cannot load here.
    return null
  }
  // Static output cannot depend on a query string. User callback failures are
  // generation failures, rather than silently replacing their declared body.
  if (userland) {
    return evaluateMd(userland.md, located.params, {})
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
    throw new Error(
      "[next-with-text] failed to load template functions from next.config",
      { cause: err }
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
  distDir: string,
  publicDir: string,
  written: Record<string, string>
): void {
  const manifestPath = join(distDir, "cache", MANIFEST)
  try {
    const previous = generatedManifest(dir, distDir)
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
