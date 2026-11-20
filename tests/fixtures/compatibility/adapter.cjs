"use strict"
const { appendFileSync, existsSync, readFileSync } = require("node:fs")
const { join } = require("node:path")

module.exports = {
  modifyConfig(config) {
    return { ...config, distDir: ".compat-next-final" }
  },
  name: "compatibility-probe",
  onBuildComplete({ config, distDir, nextVersion, outputs, projectDir }) {
    const home = outputs.prerenders.find(
      (entry) =>
        entry.pathname === (config.basePath || "/") &&
        entry.fallback?.filePath?.endsWith(".html")
    )
    appendFileSync(
      join(projectDir, "adapter-observations.jsonl"),
      `${JSON.stringify({
        distDir,
        htmlExists: home !== undefined && existsSync(home.fallback.filePath),
        index: readFileSync(join(projectDir, "public", "llms.txt"), "utf8"),
        nextVersion,
      })}\n`
    )
  },
}
