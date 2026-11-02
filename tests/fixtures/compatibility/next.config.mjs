import { withText } from "next-with-text"

export default withText(
  { distDir: ".compat-next", experimental: { cpus: 2 } },
  { exclude: ["/hidden"] }
)
