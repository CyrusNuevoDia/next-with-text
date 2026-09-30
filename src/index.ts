import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import type { NextConfig } from "next"
import {
  claimGeneratedRoute,
  cleanupGeneratedRoute,
  releaseGeneratedRoute,
} from "./cleanup.js"
import {
  appDir as findAppDir,
  userAppRoutes,
  userPublicFile,
} from "./ownership.js"
import {
  isPageFile,
  type ResolvedOptions,
  type RouteOptions,
  resolveOptions,
  type WithTextOptions,
} from "./shared.js"

const moduleDir = dirname(require.resolve("next-with-text"))

export type {
  LlmsFulltxtContext,
  LlmstxtContext,
  MarkdownContent,
  MarkdownPage,
  MarkdownProps,
  WithTextOptions,
} from "./shared.js"

type ConfigContext = {
  defaultConfig?: NextConfig
}
type ConfigFn = (
  phase: string,
  ctx: ConfigContext
) => NextConfig | Promise<NextConfig>

const CONVERTER = "@xberg-io/html-to-markdown"
const PHASE_BUILD = "phase-production-build"
const PHASE_DEV = "phase-development-server"
const ADAPTER_ENV = "NEXT_WITH_TEXT_UPSTREAM_ADAPTER"
const PAYLOAD_ENV = "NEXT_WITH_TEXT_BUILD_PAYLOAD"
const PATCHED_ENV = "NEXT_WITH_TEXT_BUILD_PATCHED"
function configureAdapter(base: NextConfig, payload: unknown): boolean {
  const upstreamAdapter = base.adapterPath ?? process.env.NEXT_ADAPTER_PATH
  if (!upstreamAdapter) {
    return false
  }
  process.env[ADAPTER_ENV] = upstreamAdapter
  process.env[PAYLOAD_ENV] = JSON.stringify(payload)
  return true
}

let patchRegistered = false
let devCleanupRegistered = false

type Capture = {
  llmsfulltxt?: WithTextOptions["llmsfulltxt"]
  llmstxt?: WithTextOptions["llmstxt"]
}

export function withText(
  nextConfig: NextConfig | ConfigFn = {},
  options: WithTextOptions = {}
): ConfigFn {
  const resolved = resolveOptions(options)

  return async (phase, ctx) => {
    const base =
      typeof nextConfig === "function"
        ? await nextConfig(phase, ctx)
        : nextConfig

    // The build-exit child re-loads this config to reach the template functions
    // (they can't cross the process boundary as JSON) — hand them over and do
    // nothing else in that pass, or the child would re-register the exit hook
    // and recurse.
    const capture = (globalThis as { __NEXT_WITH_TEXT_CAPTURE__?: Capture })
      .__NEXT_WITH_TEXT_CAPTURE__
    if (capture) {
      capture.llmsfulltxt = options.llmsfulltxt
      capture.llmstxt = options.llmstxt
      return base
    }

    const dir = process.cwd()
    const appRoutes = userAppRoutes(dir)
    if (phase === PHASE_BUILD || phase === PHASE_DEV) {
      generateRoute(dir, { ...resolved, dev: phase === PHASE_DEV })
    }
    if (phase === PHASE_DEV && !devCleanupRegistered) {
      devCleanupRegistered = true
      // Dev compiles the route from source, so it must live for the whole
      // session: claim it, and let the exit hook release the claim and clean
      // up. Whichever process loads the config gets the claim (in Next 16 dev
      // that is a NEXT_PRIVATE_WORKER process — the dev server itself), and
      // the per-pid claims are what keep a concurrent `next build`, or a
      // second dev server, from deleting the route out from under this one.
      // Next exits via process.exit() on SIGINT/SIGTERM (probe-verified in
      // every dev process), so `exit` is a reliable teardown point.
      claimGeneratedRoute(dir)
      process.once("exit", () => {
        releaseGeneratedRoute(dir)
        cleanupGeneratedRoute(dir)
      })
    }
    if (phase === PHASE_BUILD && !patchRegistered) {
      patchRegistered = true
      const payload = {
        dir,
        hasLlmsfulltxt: typeof options.llmsfulltxt === "function",
        hasLlmstxt: typeof options.llmstxt === "function",
        options: resolved,
      }
      configureAdapter(base, payload)
      // Platforms expose an adapter callback before they collect build output;
      // builds without one fall back to exit, whose handler must stay sync.
      process.once("exit", (code) => {
        if (code === 0 && process.env[PATCHED_ENV] !== "1") {
          // Published installs resolve beside index.cjs; a TS-aware config loader
          // can still execute src/index.ts directly, so check dist/ as well.
          const patch = [
            join(moduleDir, "patch.cjs"),
            join(moduleDir, "..", "dist", "patch.cjs"),
          ].find(existsSync)
          if (patch) {
            spawnSync(process.execPath, [patch, JSON.stringify(payload)], {
              stdio: "inherit",
            })
          } else {
            console.error(
              "[next-with-text] patch.cjs not found — run the package build"
            )
          }
        }
      })
    }

    const config: NextConfig = {
      ...base,
      rewrites: composeRewrites(base.rewrites, resolved, dir, appRoutes),
      // the converter is a native addon — Turbopack can't bundle it into the
      // generated route handler
      serverExternalPackages: [
        ...new Set([...(base.serverExternalPackages ?? []), CONVERTER]),
      ],
    }
    if (phase === PHASE_BUILD) {
      config.outputFileTracingIncludes = traceConverter(
        base.outputFileTracingIncludes,
        dir
      )
    }
    if (
      phase === PHASE_BUILD &&
      (base.adapterPath ?? process.env.NEXT_ADAPTER_PATH)
    ) {
      config.adapterPath = join(moduleDir, "adapter.cjs")
    }
    return config
  }
}

const LLMS_ROUTE = "/_llms/**"

// Next's file tracer follows the converter's JS entry but not the
// platform-specific binding package its loader picks at runtime, so a
// serverless bundle ships without it and the on-demand route can't convert.
// Name whichever bindings this build machine installed, at the path Node will
// look for them from the converter's real location (in an isolated install
// that path is a symlink, and the glob copies its files there).
function traceConverter(
  includes: NextConfig["outputFileTracingIncludes"],
  dir: string
): NextConfig["outputFileTracingIncludes"] {
  const bindings = converterBindings(dir)
  if (bindings.length === 0) {
    return includes
  }
  return {
    ...includes,
    [LLMS_ROUTE]: [...(includes?.[LLMS_ROUTE] ?? []), ...bindings],
  }
}

function converterBindings(dir: string): string[] {
  let converterDir: string
  try {
    converterDir = dirname(realpathSync(require.resolve(CONVERTER)))
  } catch {
    return []
  }
  const manifest = JSON.parse(
    readFileSync(join(converterDir, "package.json"), "utf8")
  ) as { optionalDependencies?: Record<string, string> }
  return Object.keys(manifest.optionalDependencies ?? {}).flatMap((name) => {
    const found = findPackage(name, converterDir)
    return found === null
      ? []
      : [`${relative(dir, found).split(sep).join("/")}/**`]
  })
}

function findPackage(name: string, from: string): string | null {
  const candidate = join(from, "node_modules", name)
  if (existsSync(candidate)) {
    return candidate
  }
  const parent = dirname(from)
  return parent === from ? null : findPackage(name, parent)
}

function generateRoute(dir: string, options: RouteOptions): void {
  const appDir = findAppDir(dir)
  if (!appDir) {
    return
  }
  // %5F is the URL-encoded underscore: a literal `_llms` folder is
  // routing-private and never mounts; this one serves /_llms/:path.
  const routeDir = join(appDir, "%5Fllms", "[...path]")
  const routeFile = join(routeDir, "route.ts")
  const loaders = scanMdPages(appDir)
    .map(
      ({ pattern, importPath }) =>
        `  ${JSON.stringify(pattern)}: () => import(${JSON.stringify(importPath)}),`
    )
    .join("\n")
  const manifest = loaders === "" ? "{}" : `{\n${loaders}\n}`
  const content = `// Generated by next-with-text at config load. Retained by builds for deployment
// tracing; deleted when the development server exits — do not edit.
import { createHandler } from "next-with-text/route"

export const GET = createHandler(${JSON.stringify(options)}, ${manifest})
`
  try {
    if (existsSync(routeFile) && readFileSync(routeFile, "utf8") === content) {
      return
    }
    mkdirSync(routeDir, { recursive: true })
    writeFileSync(routeFile, content)
  } catch {
    // read-only filesystem (serverless runtime) — the route was generated at build time
  }
}

// Pages exporting `md` get a static dynamic-import in the generated route so
// the on-demand tier can evaluate the export in every runtime — dev, start,
// serverless — through the bundler instead of loading source at request time.
function scanMdPages(
  appDir: string
): Array<{ pattern: string; importPath: string }> {
  const pages: Array<{ pattern: string; importPath: string }> = []
  walk(appDir, "")
  return pages

  function walk(dirPath: string, route: string): void {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const { name } = entry
      if (entry.isDirectory()) {
        if (isIgnoredAppDirectory(name)) {
          continue
        }
        walk(
          join(dirPath, name),
          name.startsWith("(") ? route : `${route}/${name}`
        )
        continue
      }
      addMdPage(pages, appDir, dirPath, route, name)
    }
  }
}

function addMdPage(
  pages: Array<{ pattern: string; importPath: string }>,
  appDir: string,
  dirPath: string,
  route: string,
  name: string
): void {
  if (
    !(
      isPageFile(name) &&
      MD_EXPORT.test(readFileSync(join(dirPath, name), "utf8"))
    )
  ) {
    return
  }
  const relativePage = relative(appDir, join(dirPath, name))
    .split(sep)
    .join("/")
  const rel = relativePage.slice(0, relativePage.lastIndexOf("."))
  pages.push({
    importPath: `../../${rel}`,
    pattern: route === "" ? "/" : route,
  })
}

const MD_EXPORT = /export\s+(?:const|let|var|async\s+function|function)\s+md\b/

function isIgnoredAppDirectory(name: string): boolean {
  return (
    name.startsWith("_") ||
    name.startsWith("%5F") ||
    name.startsWith("@") ||
    name.startsWith("[...")
  )
}

type RewritesFn = NonNullable<NextConfig["rewrites"]>
type RewriteRule =
  Awaited<ReturnType<RewritesFn>> extends infer R
    ? R extends unknown[]
      ? R[number]
      : never
    : never

function composeRewrites(
  userRewrites: NextConfig["rewrites"],
  options: ResolvedOptions,
  dir: string,
  appRoutes: Set<string>
): RewritesFn {
  return async () => {
    const user = userRewrites ? await userRewrites() : []
    const groups = Array.isArray(user)
      ? {
          afterFiles: user,
          beforeFiles: [] as RewriteRule[],
          fallback: [] as RewriteRule[],
        }
      : {
          afterFiles: user.afterFiles ?? [],
          beforeFiles: user.beforeFiles ?? [],
          fallback: user.fallback ?? [],
        }

    const beforeFiles = [...groups.beforeFiles]
    const afterFiles = [...groups.afterFiles]

    if (options.md) {
      // Accept negotiation: markdown-preferring clients (and not browsers, whose
      // Accept always includes text/html) get rewritten to the .md twin.
      beforeFiles.push({
        destination: "/:path.md",
        has: [
          {
            key: "accept",
            type: "header" as const,
            value: "(?!.*text/html).*text/markdown.*",
          },
        ],
        source: "/:path((?!_next|api|_llms|.*\\.md$|.*\\.txt$).*)",
      })
      // afterFiles runs after public files (a static .md still wins) but before
      // dynamic routes — a fallback rewrite would lose /tags/alpha.md to the
      // /tags/[tag] page itself.
      const customMd = [...appRoutes]
        .filter((route) => route.endsWith(".md"))
        .map(escapeRegex)
      afterFiles.push({
        destination: "/_llms/:path",
        source:
          customMd.length === 0
            ? "/:path(.*\\.md)"
            : `/:path((?!(?:${customMd.join("|")})$).*\\.md)`,
      })
    }
    if (!(appRoutes.has("llms.txt") || userPublicFile(dir, "llms.txt"))) {
      afterFiles.push({ destination: "/_llms/llms.txt", source: "/llms.txt" })
    }
    if (
      !(appRoutes.has("llms-full.txt") || userPublicFile(dir, "llms-full.txt"))
    ) {
      afterFiles.push({
        destination: "/_llms/llms-full.txt",
        source: "/llms-full.txt",
      })
    }

    return { afterFiles, beforeFiles, fallback: groups.fallback }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
