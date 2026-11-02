"use strict"

const { existsSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")

module.exports = {
  modifyConfig(config) {
    return process.env.ADAPTER_DIST_DIR
      ? { ...config, distDir: process.env.ADAPTER_DIST_DIR }
      : config
  },
  name: "next-with-text-test-probe",
  onBuildComplete({ projectDir }) {
    writeFileSync(
      join(projectDir, "adapter-probe.json"),
      JSON.stringify({
        route: existsSync(
          join(projectDir, "app", "%5Fllms", "[...path]", "route.ts")
        ),
        static: existsSync(join(projectDir, "public", "llms.txt")),
      })
    )
  },
}
