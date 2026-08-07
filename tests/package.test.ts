import { describe, expect, test } from "bun:test"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "bun"

const ROOT = join(import.meta.dir, "..")

describe("published package", () => {
  test("resolves its build helper relative to the installed CJS bundle", () => {
    const consumer = mkdtempSync(join(tmpdir(), "next-with-text-package-"))
    const installed = join(consumer, "node_modules", "next-with-text")
    mkdirSync(installed, { recursive: true })
    cpSync(join(ROOT, "dist"), join(installed, "dist"), { recursive: true })
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ main: "dist/index.cjs" })
    )
    mkdirSync(join(consumer, "app"))

    const bundled = readFileSync(join(installed, "dist", "index.cjs"), "utf8")
    expect(bundled).not.toContain(join(ROOT, "src"))

    const probe = spawnSync(
      [
        process.execPath,
        "-e",
        "require('next-with-text').withText()('phase-production-build', {})",
      ],
      { cwd: consumer, env: { ...process.env, CI: "" } }
    )
    expect(probe.stderr.toString()).not.toContain("patch.cjs not found")
    expect(probe.exitCode).toBe(0)
  })
})
