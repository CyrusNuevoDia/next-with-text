import { withText, type WithTextOptions } from "next-with-text"

const options: WithTextOptions = { exclude: ["/docs/internal/**"] }

// Alternate-config builds driven by the verifier suite (docs/shaping.md checks).
if (process.env.LLMSTXT_FN === "1") {
  options.llmstxt = ({ title, description, routes }) =>
    [
      `LLMSTXT_FN:${title}:${description}`,
      ...routes.map((r) => `ROUTE:${r.title}|${r.href}|${r.description}`),
    ].join("\n")
}
if (process.env.MD_OFF === "1") options.md = false

export default withText({}, options)
