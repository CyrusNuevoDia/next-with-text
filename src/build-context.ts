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
  const pages = new Map<string, CompiledPage>()
  for (const page of appPages.toSorted(
    (a, b) =>
      Number(a.sourcePage.includes("/@")) - Number(b.sourcePage.includes("/@"))
  )) {
    // Next emits an RSC sibling with the same module. sourcePage names the
    // canonical route independently of that extra pathname and of disk layout.
    const pattern = normalizeAppPath(page.sourcePage)
    if (page.pathname !== pattern || privateRoute(pattern)) {
      continue
    }
    if (!pages.has(pattern)) {
      pages.set(pattern, { filePath: page.filePath, pattern })
    }
  }
  return {
    basePath,
    distDir,
    pages: [...pages.values()],
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

function middlewareMatchers(input: unknown): string[] {
  if (input === undefined) {
    return []
  }
  const middleware = object(input, "middleware")
  const config = object(middleware.config, "middleware config")
  return array(config.matchers, "middleware matchers").flatMap((value) => {
    const matcher = object(value, "middleware matcher")
    const source = string(matcher.sourceRegex, "middleware sourceRegex")
    // Validate even conditional matchers: malformed guards must not quietly
    // turn into publishable routes after a Next upgrade.
    const expression = new RegExp(source)
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
        condition.type === "header" &&
        condition.key === "x-prerender-revalidate"
      )
    })
    return has.length || userMissing.length ? [] : [expression.source]
  })
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

function absolutePath(value: unknown, name: string): string {
  const path = string(value, name)
  if (!isAbsolute(path)) {
    throw new Error(`[next-with-text] ${name} must be an absolute path`)
  }
  return path
}
