import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { NextAdapter } from "next"
import { adapterPrerenders } from "./shared.js"

type NextConfigComplete = Parameters<
  NonNullable<NextAdapter["modifyConfig"]>
>[0]

const upstreamPath = process.env.NEXT_WITH_TEXT_UPSTREAM_ADAPTER
const moduleDir = dirname(require.resolve("next-with-text"))
async function upstream(): Promise<NextAdapter | undefined> {
  if (!upstreamPath) {
    return
  }
  const loaded = await import(upstreamPath)
  return (loaded.default ?? loaded) as NextAdapter
}

const adapter: NextAdapter = {
  async modifyConfig(config, ctx) {
    const delegate = await upstream()
    const modified = delegate?.modifyConfig
      ? await delegate.modifyConfig(config, ctx)
      : config
    return {
      ...modified,
      adapterPath: join(moduleDir, "adapter.cjs"),
    } as NextConfigComplete
  },
  name: "next-with-text",
  async onBuildComplete(ctx) {
    const payload = process.env.NEXT_WITH_TEXT_BUILD_PAYLOAD
    if (payload) {
      // The outputs say where each prerendered page's HTML landed; the child
      // must not guess a dist layout. They go through a file because Linux
      // caps a single argv entry at 128KB and a large site's list exceeds it.
      const handoff = mkdtempSync(join(tmpdir(), "next-with-text-"))
      const prerenders = join(handoff, "prerenders.json")
      writeFileSync(
        prerenders,
        JSON.stringify(adapterPrerenders(ctx.outputs, ctx.config.basePath))
      )
      try {
        const patch = spawnSync(
          process.execPath,
          [join(moduleDir, "patch.cjs"), payload, prerenders],
          { stdio: "inherit" }
        )
        if (patch.status === 0) {
          process.env.NEXT_WITH_TEXT_BUILD_PATCHED = "1"
        }
      } finally {
        rmSync(handoff, { force: true, recursive: true })
      }
    }
    const delegate = await upstream()
    await delegate?.onBuildComplete?.(ctx)
  },
}

export = adapter
