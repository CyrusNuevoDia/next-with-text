import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import type { NextAdapter, NextConfigComplete } from "next"

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
      const patch = spawnSync(
        process.execPath,
        [join(moduleDir, "patch.cjs"), payload],
        {
          stdio: "inherit",
        }
      )
      if (patch.status === 0) {
        process.env.NEXT_WITH_TEXT_BUILD_PATCHED = "1"
      }
    }
    const delegate = await upstream()
    await delegate?.onBuildComplete?.(ctx)
  },
}

export = adapter
