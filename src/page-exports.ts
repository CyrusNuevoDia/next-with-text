import { type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { NextConfig } from "next"

const EXPORT_CHECK =
  "// Check that the entry is a valid entry\ncheckFields<Diff<{\n"
const EXPORT_CHECK_END = "}, TEntry, ''>>()"
type CompileHook = NonNullable<
  NonNullable<NextConfig["compiler"]>["runAfterProductionCompile"]
>

export function withPageExports(
  userHook: CompileHook | undefined
): CompileHook {
  return async (context) => {
    // This public hook runs after compilation and before Next's production
    // type check. Only Webpack emits the closed Page-export whitelist below.
    repairPageExports(join(context.distDir, "types", "app"))
    await userHook?.(context)
  }
}

function repairPageExports(dir: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    // Turbopack uses a structural validator and has no per-page guard tree.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return
    }
    throw error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      repairPageExports(path)
    } else if (entry.isFile() && entry.name === "page.ts") {
      const source = readFileSync(path, "utf8")
      if (!source.startsWith("// File: ")) {
        continue
      }
      // Extend only Next's export whitelist, preserving the checks for page
      // props, metadata and every other export. Source types still check md.
      if (
        !(source.includes(EXPORT_CHECK) && source.includes(EXPORT_CHECK_END))
      ) {
        throw new Error(
          `[next-with-text] unsupported Next Page validator: ${path}`
        )
      }
      writeFileSync(
        path,
        source.replace(EXPORT_CHECK, `${EXPORT_CHECK}  md?: unknown\n`)
      )
    }
  }
}
