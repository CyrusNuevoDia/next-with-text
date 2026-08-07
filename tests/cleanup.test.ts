// Safety contract of the generated-route cleanup: it must only ever remove
// what next-with-text itself generated, and must never take user files with it.
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupGeneratedRoute, GENERATED_MARKER } from "../src/cleanup"

function makeApp(): { dir: string; routeDir: string; routeFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "nwt-cleanup-"))
  const routeDir = join(dir, "app", "%5Fllms")
  mkdirSync(join(routeDir, "[...path]"), { recursive: true })
  return { dir, routeDir, routeFile: join(routeDir, "[...path]", "route.ts") }
}

describe("cleanupGeneratedRoute", () => {
  test("removes a generated route file and its emptied folders", () => {
    const { dir, routeDir, routeFile } = makeApp()
    writeFileSync(routeFile, `${GENERATED_MARKER} at config load\nexport {}\n`)
    cleanupGeneratedRoute(dir)
    expect(existsSync(routeDir)).toBe(false)
  })

  test("leaves a user-authored route at the same path untouched", () => {
    const { dir, routeFile } = makeApp()
    const userContent =
      "export function GET() { return new Response('mine') }\n"
    writeFileSync(routeFile, userContent)
    cleanupGeneratedRoute(dir)
    expect(readFileSync(routeFile, "utf8")).toBe(userContent)
  })

  test("keeps the folder and any user files in it when only route.ts is ours", () => {
    const { dir, routeDir, routeFile } = makeApp()
    writeFileSync(routeFile, `${GENERATED_MARKER} at config load\nexport {}\n`)
    const userFile = join(routeDir, "notes.md")
    writeFileSync(userFile, "mine")
    cleanupGeneratedRoute(dir)
    expect(existsSync(routeFile)).toBe(false)
    expect(readFileSync(userFile, "utf8")).toBe("mine")
  })

  test("no app directory is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "nwt-cleanup-"))
    expect(() => cleanupGeneratedRoute(dir)).not.toThrow()
  })
})
