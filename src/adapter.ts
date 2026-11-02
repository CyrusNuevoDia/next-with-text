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
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { NextConfig } from "next"
import {
  type BuildPayload,
  buildContext,
  registerAdapter,
} from "./build-context.js"
import { generateRoute } from "./generated-route.js"
import { withPageExports } from "./page-exports.js"

type Adapter = {
  modifyConfig?: (
    config: NextConfig,
    ctx: unknown
  ) => NextConfig | Promise<NextConfig>
  onBuildComplete?: (ctx: unknown) => void | Promise<void>
}

const moduleDir = dirname(require.resolve("next-with-text"))
let delegate: Promise<Adapter | undefined> | undefined

function upstream(projectDir: string): Promise<Adapter | undefined> {
  delegate ??= loadUpstream(projectDir)
  return delegate
}

async function loadUpstream(projectDir: string): Promise<Adapter | undefined> {
  const path = process.env.NEXT_WITH_TEXT_UPSTREAM_ADAPTER
  if (!path) {
    return
  }
  const requireFrom = createRequire(join(projectDir, "package.json"))
  let resolved = path
  if (!isAbsolute(path)) {
    resolved = path.startsWith(".")
      ? resolve(projectDir, path)
      : requireFrom.resolve(path)
  }
  if (resolved === join(moduleDir, "adapter.cjs")) {
    throw new Error("[next-with-text] an adapter cannot delegate to itself")
  }
  const loaded = await import(pathToFileURL(resolved).href)
  return (loaded.default ?? loaded) as Adapter
}

const adapter = {
  async modifyConfig(config: NextConfig, ctx: { projectDir?: string }) {
    const payload = process.env.NEXT_WITH_TEXT_BUILD_PAYLOAD
    if (!payload) {
      throw new Error("[next-with-text] missing generation options")
    }
    const registration = JSON.parse(payload) as BuildPayload
    // Earlier 16.x config hooks omit projectDir; withText captured it when
    // registering this adapter. The build-complete context supplies it in all 16.x.
    registration.projectDir = ctx.projectDir ?? registration.projectDir
    const upstreamAdapter = await upstream(registration.projectDir)
    const modified = upstreamAdapter?.modifyConfig
      ? await upstreamAdapter.modifyConfig(config, ctx)
      : config
    const field = process.env.NEXT_WITH_TEXT_ADAPTER_FIELD
    if (field !== "experimental" && field !== "stable") {
      throw new Error("[next-with-text] missing adapter registration context")
    }
    registration.distDir = modified.distDir ?? ".next"
    process.env.NEXT_WITH_TEXT_BUILD_PAYLOAD = JSON.stringify(registration)
    generateRoute(registration.projectDir, {
      ...registration.options,
      dev: false,
      distDir: registration.distDir,
    })
    return registerAdapter(
      {
        ...modified,
        compiler: {
          ...modified.compiler,
          runAfterProductionCompile: withPageExports(
            modified.compiler?.runAfterProductionCompile
          ),
        },
      },
      join(moduleDir, "adapter.cjs"),
      field
    )
  },
  name: "next-with-text",
  async onBuildComplete(ctx: unknown) {
    const payload = process.env.NEXT_WITH_TEXT_BUILD_PAYLOAD
    if (!payload) {
      throw new Error("[next-with-text] missing generation options")
    }
    // Validate auth guards before invoking a child that can write public files.
    const context = buildContext(ctx)
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
      const { standaloneDir } = context
      if (standaloneDir) {
        const staging = join(
          context.distDir,
          "cache",
          "next-with-text-standalone"
        )
        const target = join(standaloneDir, "public")
        const cacheTarget = join(
          standaloneDir,
          relative(context.projectDir, context.distDir),
          "cache",
          "next-with-text-routes.json"
        )
        // Next deletes/rebuilds standalone after this hook. Generation has
        // already succeeded; exit only copies its staged files into that tree.
        process.once("exit", (code) => {
          try {
            if (code === 0) {
              if (!existsSync(standaloneDir)) {
                throw new Error("standalone output was not created")
              }
              mkdirSync(target, { recursive: true })
              cpSync(staging, target, {
                errorOnExist: false,
                force: false,
                recursive: true,
              })
              mkdirSync(dirname(cacheTarget), { recursive: true })
              copyFileSync(
                join(context.distDir, "cache", "next-with-text-routes.json"),
                cacheTarget
              )
            }
          } catch (error) {
            console.error(
              "[next-with-text] standalone finalization failed:",
              error
            )
            process.exitCode = 1
          } finally {
            rmSync(staging, { force: true, recursive: true })
          }
        })
      }
    } finally {
      rmSync(handoff, { force: true, recursive: true })
    }
    const upstreamAdapter = await upstream(context.projectDir)
    await upstreamAdapter?.onBuildComplete?.(ctx)
  },
}

export = adapter
