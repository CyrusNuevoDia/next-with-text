import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { type WithTextOptions, withText } from "next-with-text"

const options: WithTextOptions = { exclude: ["/docs/internal/**"] }

// Alternate-config builds driven by the verifier suite (docs/shaping.md checks).
if (process.env.LLMSTXT_FN === "1") {
  options.llmstxt = ({ title, description, sections }) =>
    [
      `LLMSTXT_FN:${title}:${description}`,
      ...sections.flatMap((s) => [
        `SECTION:${s.title}`,
        ...s.routes.map((r) => `ROUTE:${r.title}|${r.href}|${r.description}`),
      ]),
    ].join("\n")
}
if (process.env.LLMSTXT_FN === "throw") {
  options.llmstxt = () => {
    writeFileSync(join(process.cwd(), "llmstxt-invoked"), "yes")
    return "unexpected generated index"
  }
}
if (process.env.LLMSFULLTXT_FN === "1") {
  options.llmsfulltxt = ({ title, description, sections }) =>
    [
      `LLMSFULLTXT_FN:${title}:${description}`,
      ...sections.flatMap((s) => [
        `SECTION:${s.title}`,
        ...s.routes.map(
          (r) => `ROUTE:${r.title}|${r.href}|${r.description}|${r.content}`
        ),
      ]),
    ].join("\n")
}
if (process.env.LLMSFULLTXT_FN === "track") {
  options.llmsfulltxt = () => {
    writeFileSync(join(process.cwd(), "llmsfulltxt-invoked"), "yes")
    return "unexpected generated full text"
  }
}
if (process.env.MD_OFF === "1") {
  options.md = false
}

// Standalone output copies only traced files, like a serverless deploy bundle.
export default withText(
  process.env.STANDALONE === "1" ? { output: "standalone" } : {},
  options
)
