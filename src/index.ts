import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { NextConfig } from "next"
import {
  adapterField,
  type BuildPayload,
  legacyBuildContext,
  registerAdapter,
} from "./build-context.js"
import {
  claimGeneratedRoute,
  cleanupGeneratedRoute,
  releaseGeneratedRoute,
} from "./cleanup.js"
import { generateRoute } from "./generated-route.js"
import { finishStandalone, generate } from "./generation.js"
import {
  generatedManifest,
  userAppRoutes,
  userPublicFile,
} from "./ownership.js"
import { withPageExports } from "./page-exports.js"
import {
  type ResolvedOptions,
  resolveOptions,
  type WithTextOptions,
} from "./shared.js"

const moduleDir = dirname(require.resolve("next-with-text"))

export type { ConversionResult } from "@xberg-io/html-to-markdown"
export type {
  LlmsFulltxtContext,
  LlmstxtContext,
  MarkdownContent,
  MarkdownPage,
  MarkdownProps,
  WithTextOptions,
} from "./shared.js"
// biome-ignore lint/performance/noBarrelFile: the package entry is the converter's only public path
export { ConverterUnavailableError, convertHTMLtoMarkdown } from "./shared.js"

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

    // The generation child reloads config to recover callback closures. Capture
    // them without registering another adapter or rewriting generated source.
    const capture = (globalThis as { __NEXT_WITH_TEXT_CAPTURE__?: Capture })
      .__NEXT_WITH_TEXT_CAPTURE__
    if (capture) {
      capture.llmsfulltxt = options.llmsfulltxt
      capture.llmstxt = options.llmstxt
      return base
    }

    const dir = process.cwd()
    const distDir = resolve(dir, base.distDir ?? ".next")
    const appRoutes = userAppRoutes(dir)
    if (phase === PHASE_DEV) {
      generateRoute(dir, {
        ...resolved,
        dev: true,
        distDir: base.distDir ?? ".next",
      })
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
        cleanupGeneratedRoute(dir, distDir)
      })
    }

    const config: NextConfig = {
      ...base,
      rewrites: composeRewrites(
        base.rewrites,
        resolved,
        dir,
        appRoutes,
        distDir,
        phase
      ),
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
      return configureBuild(config, dir, options, resolved)
    }
    return config
  }
}

function configureBuild(
  config: NextConfig,
  dir: string,
  options: WithTextOptions,
  resolved: ResolvedOptions
): NextConfig {
  const version = JSON.parse(
    readFileSync(require.resolve("next/package.json", { paths: [dir] }), "utf8")
  ).version as string
  const field = adapterField(version)
  const experimental = config.experimental as typeof config.experimental & {
    adapterPath?: string
  }
  const upstream =
    config.adapterPath ??
    experimental?.adapterPath ??
    process.env.NEXT_ADAPTER_PATH
  // Turbopack replays raw config after modifyConfig without calling the
  // adapter again. Only the adapter may replace the final build directory.
  const previous = process.env[PAYLOAD_ENV]
    ? (JSON.parse(process.env[PAYLOAD_ENV]) as BuildPayload)
    : undefined
  const payload = {
    distDir:
      upstream && previous?.projectDir === dir
        ? previous.distDir
        : (config.distDir ?? ".next"),
    hasLlmsfulltxt: typeof options.llmsfulltxt === "function",
    hasLlmstxt: typeof options.llmstxt === "function",
    options: resolved,
    projectDir: dir,
  } satisfies BuildPayload
  process.env[PAYLOAD_ENV] = JSON.stringify(payload)
  if (!upstream) {
    // Any adapterPath makes Next store prerenders under server/route-cache,
    // which platforms reading .next directly (Vercel's builder) can't find.
    // With no adapter to compose with, generate from Next's own manifests.
    delete process.env[ADAPTER_ENV]
    generateRoute(dir, { ...resolved, dev: false, distDir: payload.distDir })
    registerBuildExit(dir, resolve(dir, payload.distDir))
    return {
      ...config,
      compiler: {
        ...config.compiler,
        runAfterProductionCompile: withPageExports(
          config.compiler?.runAfterProductionCompile
        ),
      },
    }
  }
  process.env[ADAPTER_ENV] = upstream
  process.env.NEXT_WITH_TEXT_ADAPTER_FIELD = field
  return registerAdapter(config, join(moduleDir, "adapter.cjs"), field)
}

const OWNER_ENV = "NEXT_WITH_TEXT_BUILD_OWNER"
let buildExitRegistered = false

function registerBuildExit(dir: string, distDir: string): void {
  // Next's build workers load this config too and inherit the build's env;
  // only the process that ran the build may generate from its output.
  const owner = process.env[OWNER_ENV]
  if (buildExitRegistered || (owner && owner !== String(process.pid))) {
    return
  }
  buildExitRegistered = true
  process.env[OWNER_ENV] = String(process.pid)
  // Next has written its manifests and standalone tree by exit, and a
  // platform builder reads public/ only after `next build` exits.
  process.once("exit", (code) => {
    if (code !== 0) {
      return
    }
    try {
      const context = legacyBuildContext(dir, distDir)
      generate(process.env[PAYLOAD_ENV] ?? "", context)
      finishStandalone(context, true)
    } catch (error) {
      console.error("[next-with-text] generation failed:", error)
      process.exitCode = 1
    }
  })
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

type RewritesFn = NonNullable<NextConfig["rewrites"]>
type RewriteRule =
  Awaited<ReturnType<RewritesFn>> extends infer R
    ? R extends unknown[]
      ? R[number]
      : never
    : never

function manifestForRewrites(
  dir: string,
  distDir: string,
  phase: string
): Record<string, string> {
  // Next asks for rewrites after adapter.modifyConfig. Its final distDir can
  // differ from the user's initial config, including where ownership lives.
  if (phase !== PHASE_BUILD) {
    return generatedManifest(dir, distDir)
  }
  const payload = JSON.parse(
    process.env[PAYLOAD_ENV] ?? "{}"
  ) as Partial<BuildPayload>
  const finalDistDir =
    payload.projectDir === dir && payload.distDir
      ? resolve(dir, payload.distDir)
      : distDir
  return generatedManifest(dir, finalDistDir)
}

function composeRewrites(
  userRewrites: NextConfig["rewrites"],
  options: ResolvedOptions,
  dir: string,
  appRoutes: Set<string>,
  distDir: string,
  phase: string
): RewritesFn {
  return async () => {
    const manifest = manifestForRewrites(dir, distDir, phase)
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
    if (
      !(appRoutes.has("llms.txt") || userPublicFile(dir, "llms.txt", manifest))
    ) {
      afterFiles.push({ destination: "/_llms/llms.txt", source: "/llms.txt" })
    }
    if (
      !(
        appRoutes.has("llms-full.txt") ||
        userPublicFile(dir, "llms-full.txt", manifest)
      )
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
