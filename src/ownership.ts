import { createHash } from "node:crypto"
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const MANIFEST = "next-with-text-manifest.json"
const ROUTE_FILE = /^(?:page|route)\.(?:js|jsx|ts|tsx)$/

export function appDir(dir: string): string | undefined {
  return ["src/app", "app"].map((path) => join(dir, path)).find(existsSync)
}

export function userAppRoutes(dir: string): Set<string> {
  const root = appDir(dir)
  const routes = new Set<string>()
  if (!root) {
    return routes
  }
  walk(root, [])
  return routes

  function walk(current: string, segments: string[]): void {
    for (const entry of safeReadDir(current)) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith("%5F") || entry.name.startsWith("_")) {
          continue
        }
        walk(
          join(current, entry.name),
          (entry.name.startsWith("(") && entry.name.endsWith(")")) ||
            entry.name.startsWith("@")
            ? segments
            : [...segments, entry.name]
        )
      } else if (ROUTE_FILE.test(entry.name) && segments.length > 0) {
        routes.add(segments.join("/"))
      }
    }
  }
}

export function userPublicFile(
  dir: string,
  rel: string,
  manifest = generatedManifest(dir)
): boolean {
  const target = join(dir, "public", rel)
  if (!existsSync(target)) {
    return false
  }
  const expected = manifest[rel]
  return (
    expected === undefined || hashOf(readFileSync(target, "utf8")) !== expected
  )
}

export function generatedManifest(dir: string): Record<string, string> {
  const path = join(dir, ".next", "cache", MANIFEST)
  if (!existsSync(path)) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {}
  } catch {
    return {}
  }
}

export function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

function safeReadDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
