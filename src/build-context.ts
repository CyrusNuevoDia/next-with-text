import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import type { NextConfig } from "next"
import {
  adapterPrerenders,
  type PrerenderedHTML,
  type ResolvedOptions,
} from "./shared.js"

export type AdapterField = "stable" | "experimental"

const NEXT_VERSION = /^16\.(\d+)\.\d+(?:-.+)?$/

export function adapterField(version: string): AdapterField {
  const parsed = NEXT_VERSION.exec(version)
  if (!parsed) {
    throw new Error(
      `[next-with-text] Next.js ${version} is unsupported; use Next.js 16.x`
    )
  }
  return Number(parsed[1]) < 2 ? "experimental" : "stable"
}

type AdapterConfig = NextConfig & {
  experimental?: NextConfig["experimental"] & { adapterPath?: string }
}

export function registerAdapter(
  config: AdapterConfig,
  path: string,
  field: AdapterField
): AdapterConfig {
  const { adapterPath: _adapterPath, experimental: previous, ...rest } = config
  const { adapterPath: _experimentalAdapterPath, ...experimental } =
    previous ?? {}
  return field === "experimental"
    ? { ...rest, experimental: { ...experimental, adapterPath: path } }
    : { ...rest, adapterPath: path, experimental }
}

export type CompiledPage = { pattern: string; filePath: string }

export type BuildPayload = {
  projectDir: string
  distDir: string
  hasLlmsfulltxt: boolean
  hasLlmstxt: boolean
  options: ResolvedOptions
}

export type BuildContext = {
  projectDir: string
  distDir: string
  basePath: string
  prerenderedHTML: PrerenderedHTML
  pages: CompiledPage[]
  proxyMatchers: string[]
  standaloneDir?: string
}

// This is the adapter API boundary. Its output paths survive Next's storage
// changes, and middleware outputs exist in both the routes and routing eras.
export function buildContext(input: unknown): BuildContext {
  const ctx = object(input, "adapter context")
  const projectDir = absolutePath(ctx.projectDir, "projectDir")
  const distDir = absolutePath(ctx.distDir, "distDir")
  const config = object(ctx.config, "config")
  const basePath = string(config.basePath, "config.basePath")
  const outputs = object(ctx.outputs, "outputs")
  const appPages = array(outputs.appPages, "outputs.appPages").map((value) => {
    const page = object(value, "app page")
    return {
      filePath: absolutePath(page.filePath, "app page filePath"),
      id: string(page.id, "app page id"),
      pathname: string(page.pathname, "app page pathname"),
      sourcePage: string(page.sourcePage, "app page sourcePage"),
    }
  })
  const prerenders = array(outputs.prerenders, "outputs.prerenders").map(
    (value) => {
      const output = object(value, "prerender")
      const fallback =
        output.fallback === undefined
          ? undefined
          : object(output.fallback, "prerender fallback")
      return {
        fallback: fallback && {
          filePath:
            fallback.filePath === undefined
              ? undefined
              : absolutePath(fallback.filePath, "prerender filePath"),
          postponedState: fallback.postponedState,
        },
        parentOutputId: string(
          output.parentOutputId,
          "prerender parentOutputId"
        ),
        pathname: string(output.pathname, "prerender pathname"),
        routeType:
          output.routeType === undefined
            ? undefined
            : string(output.routeType, "prerender routeType"),
      }
    }
  )
  // Next emits an RSC sibling with the same module. sourcePage names the
  // canonical route independently of that extra pathname and of disk layout.
  const pages = canonicalPages(
    appPages.filter(
      (page) => page.pathname === normalizeAppPath(page.sourcePage)
    )
  )
  return {
    basePath,
    distDir,
    pages,
    prerenderedHTML: adapterPrerenders({ appPages, prerenders }, basePath),
    projectDir,
    proxyMatchers: middlewareMatchers(outputs.middleware),
    ...(config.output === "standalone"
      ? {
          standaloneDir: join(
            distDir,
            "standalone",
            relative(
              absolutePath(
                config.outputFileTracingRoot,
                "config.outputFileTracingRoot"
              ),
              projectDir
            )
          ),
        }
      : {}),
  }
}

// Without an adapter, Next keeps its legacy layout (server/app/<route>.html)
// and describes the build only through its manifests. Registering an adapter
// just to read outputs would move prerenders into server/route-cache, which
// platforms that read .next directly (Vercel's builder) cannot find.
export function legacyBuildContext(
  projectDir: string,
  distDir: string
): BuildContext {
  const read = (rel: string) =>
    JSON.parse(readFileSync(join(distDir, rel), "utf8")) as unknown
  const server = join(distDir, "server")
  const appPaths = object(
    read("server/app-paths-manifest.json"),
    "app paths manifest"
  )
  const pages = canonicalPages(
    Object.entries(appPaths)
      .filter(([sourcePage]) => sourcePage.endsWith("/page"))
      .map(([sourcePage, file]) => ({
        filePath: join(server, string(file, "app page file")),
        sourcePage,
      }))
  )
  const prerenderedHTML: PrerenderedHTML = {}
  const routes = object(
    object(read("prerender-manifest.json"), "prerender manifest").routes,
    "prerender routes"
  )
  for (const [route, value] of Object.entries(routes)) {
    const entry = object(value, "prerender route")
    if (
      (entry.routeType ?? "page") !== "page" ||
      route.includes("[") ||
      privateRoute(route)
    ) {
      continue
    }
    const base = join(server, "app", route === "/" ? "index" : route.slice(1))
    // App Router HTML lives here; Pages Router prerenders live elsewhere. A
    // postponed shell is not the page's content.
    if (!existsSync(`${base}.html`) || postponed(`${base}.meta`)) {
      continue
    }
    prerenderedHTML[route] = `${base}.html`
  }
  const proxyMatchers = [
    ...Object.values(
      object(
        object(
          read("server/functions-config-manifest.json"),
          "functions config manifest"
        ).functions ?? {},
        "functions"
      )
    ),
    ...Object.values(
      object(
        object(read("server/middleware-manifest.json"), "middleware manifest")
          .middleware ?? {},
        "middleware"
      )
    ),
  ].flatMap((value) =>
    array(object(value, "proxy function").matchers ?? [], "matchers").flatMap(
      (input) => {
        const matcher = object(input, "proxy matcher")
        const source = regex(matcher.regexp, "proxy matcher regexp")
        return unconditional(matcher) ? [source] : []
      }
    )
  )
  const routesManifest = object(read("routes-manifest.json"), "routes manifest")
  const serverConfig = object(
    object(read("required-server-files.json"), "required server files").config,
    "server config"
  )
  return {
    basePath: string(routesManifest.basePath ?? "", "basePath"),
    distDir,
    pages,
    prerenderedHTML,
    projectDir,
    proxyMatchers,
    ...(serverConfig.output === "standalone"
      ? {
          standaloneDir: join(
            distDir,
            "standalone",
            relative(
              absolutePath(
                serverConfig.outputFileTracingRoot,
                "config.outputFileTracingRoot"
              ),
              projectDir
            )
          ),
        }
      : {}),
  }
}

function postponed(metaFile: string): boolean {
  if (!existsSync(metaFile)) {
    return false
  }
  const meta = object(JSON.parse(readFileSync(metaFile, "utf8")), "page meta")
  return meta.postponed !== undefined && meta.postponed !== null
}

function canonicalPages(
  candidates: Array<{ filePath: string; sourcePage: string }>
): CompiledPage[] {
  const pages = new Map<string, CompiledPage>()
  for (const page of candidates.toSorted(
    (a, b) =>
      Number(a.sourcePage.includes("/@")) - Number(b.sourcePage.includes("/@"))
  )) {
    const pattern = normalizeAppPath(page.sourcePage)
    if (!(privateRoute(pattern) || pages.has(pattern))) {
      pages.set(pattern, { filePath: page.filePath, pattern })
    }
  }
  return [...pages.values()]
}

function middlewareMatchers(input: unknown): string[] {
  if (input === undefined) {
    return []
  }
  const middleware = object(input, "middleware")
  const config = object(middleware.config, "middleware config")
  return array(config.matchers, "middleware matchers").flatMap((value) => {
    const matcher = object(value, "middleware matcher")
    const source = regex(matcher.sourceRegex, "middleware sourceRegex")
    return unconditional(matcher) ? [source] : []
  })
}

// Validate even conditional matchers: malformed guards must not quietly turn
// into publishable routes after a Next upgrade. Only an unconditional matcher
// guards a route outright; `has: accept` alone would exclude every page.
function unconditional(matcher: Record<string, unknown>): boolean {
  const has =
    matcher.has === undefined
      ? []
      : array(matcher.has, "matcher has").map(matcherCondition)
  const missing =
    matcher.missing === undefined
      ? []
      : array(matcher.missing, "matcher missing").map(matcherCondition)
  const userMissing = missing.filter((condition) => {
    // Next adds this internal bypass to every proxy, including plain path
    // guards. It isn't a user condition making the route public.
    return !(
      condition.type === "header" && condition.key === "x-prerender-revalidate"
    )
  })
  return !(has.length || userMissing.length)
}

function matcherCondition(value: unknown): Record<string, unknown> {
  const condition = object(value, "matcher condition")
  if (
    !["header", "cookie", "query", "host"].includes(
      string(condition.type, "matcher condition type")
    )
  ) {
    throw new Error("[next-with-text] invalid matcher condition type")
  }
  if (condition.type !== "host") {
    string(condition.key, "matcher condition key")
  }
  if (condition.value !== undefined) {
    string(condition.value, "matcher condition value")
  }
  return condition
}

function normalizeAppPath(sourcePage: string): string {
  const segments = sourcePage
    .split("/")
    .filter(
      (segment) =>
        segment &&
        !segment.startsWith("@") &&
        !(segment.startsWith("(") && segment.endsWith(")"))
    )
  if (segments.at(-1) === "page" || segments.at(-1) === "route") {
    segments.pop()
  }
  return `/${segments.join("/")}`
}

function privateRoute(route: string): boolean {
  return route
    .split("/")
    .some((segment) => segment.startsWith("_") || segment.startsWith("%5F"))
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[next-with-text] invalid ${name}`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[next-with-text] invalid ${name}`)
  }
  return value
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`[next-with-text] invalid ${name}`)
  }
  return value
}

// Compiling rejects a malformed guard instead of letting it publish routes.
function regex(value: unknown, name: string): string {
  const { source } = new RegExp(string(value, name))
  return source
}

function absolutePath(value: unknown, name: string): string {
  const path = string(value, name)
  if (!isAbsolute(path)) {
    throw new Error(`[next-with-text] ${name} must be an absolute path`)
  }
  return path
}
