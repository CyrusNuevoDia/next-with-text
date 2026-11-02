import { expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateRoute } from "../src/generated-route.js"

test("refuses to overwrite a user-authored reserved route", () => {
  const dir = mkdtempSync(join(tmpdir(), "next-with-text-route-owner-"))
  try {
    const routeDir = join(dir, "app", "%5Fllms", "[...path]")
    mkdirSync(routeDir, { recursive: true })
    const path = join(routeDir, "route.ts")
    const original = 'export const GET = () => new Response("user-owned")\n'
    writeFileSync(path, original)
    let failure: unknown
    try {
      generateRoute(dir, {
        dev: false,
        exclude: [],
        include: ["**/*"],
        md: true,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).cause)).toContain("Move your custom route")
    expect(readFileSync(path, "utf8")).toBe(original)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
