import entry from "./index.cjs"

// Explicit exports let Node's ESM loader use the same runtime as require().
export const { withText, convertHTMLtoMarkdown, ConverterUnavailableError } =
  entry

// biome-ignore lint/performance/noBarrelFile: preserve the CommonJS default import at the public ESM boundary
export { default } from "./index.cjs"
