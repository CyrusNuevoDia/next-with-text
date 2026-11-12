import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { BuildContext } from "./build-context.js"

const moduleDir = dirname(require.resolve("next-with-text"))

// Runs the generation child against a validated build context. A standalone
// build stages its public tier in the cache; finishStandalone copies it in
// once Next has finished writing the standalone tree.
export function generate(payload: string, context: BuildContext): void {
  const handoff = mkdtempSync(join(tmpdir(), "next-with-text-"))
  try {
    // File transport avoids Linux's single-argv limit on large route lists.
    const contextFile = join(handoff, "build-context.json")
    writeFileSync(contextFile, JSON.stringify(context))
    const patch = spawnSync(
      process.execPath,
      [join(moduleDir, "patch.cjs"), payload, contextFile],
      { stdio: "inherit" }
    )
    if (patch.error || patch.status !== 0) {
      throw new Error("[next-with-text] generation failed", {
        cause: patch.error,
      })
    }
  } finally {
    rmSync(handoff, { force: true, recursive: true })
  }
}

export function finishStandalone(
  context: BuildContext,
  succeeded: boolean
): void {
  const { standaloneDir } = context
  if (!standaloneDir) {
    return
  }
  const staging = join(context.distDir, "cache", "next-with-text-standalone")
  try {
    if (!succeeded) {
      return
    }
    if (!existsSync(standaloneDir)) {
      throw new Error("standalone output was not created")
    }
    const target = join(standaloneDir, "public")
    mkdirSync(target, { recursive: true })
    cpSync(staging, target, {
      errorOnExist: false,
      force: false,
      recursive: true,
    })
    const cacheTarget = join(
      standaloneDir,
      relative(context.projectDir, context.distDir),
      "cache",
      "next-with-text-routes.json"
    )
    mkdirSync(dirname(cacheTarget), { recursive: true })
    copyFileSync(
      join(context.distDir, "cache", "next-with-text-routes.json"),
      cacheTarget
    )
  } finally {
    rmSync(staging, { force: true, recursive: true })
  }
}
