import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { withText } from "next-with-text"

const config = { distDir: ".compat-next", experimental: { cpus: 2 } }
if (process.env.NEXT_COMPAT_MODE === "adapter") {
  const { version } = createRequire(import.meta.url)("next/package.json")
  const adapterPath = fileURLToPath(new URL("./adapter.cjs", import.meta.url))
  if (Number(version.split(".")[1]) < 2) {
    config.experimental.adapterPath = adapterPath
  } else {
    config.adapterPath = adapterPath
  }
}
if (process.env.NEXT_COMPAT_BASE_PATH === "1") {
  config.basePath = "/docs"
}

export default withText(config, { exclude: ["/hidden"] })
