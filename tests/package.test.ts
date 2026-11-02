import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "bun"

const ROOT = join(import.meta.dir, "..")
const SAMPLE_HTML = `<html><head><title>Setup</title><meta name="description" content="How to install"><meta name="viewport" content="width=device-width"></head><body><main><h1>Setup</h1><p>Install it.</p><svg><path d="M0 0"/></svg><img alt="Pixel" src="data:image/png;base64,AAAA"><img alt="Diagram" src="/diagram.png"></main><footer>Copyright</footer></body></html>`

function run(cmd: string[], cwd: string): string {
  const probe = spawnSync(cmd, {
    cwd,
    env: { ...process.env, CI: "", NEXT_WITH_TEXT_STATIC: "0", VERCEL: "" },
  })
  if (probe.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed:\n${probe.stdout}\n${probe.stderr}`
    )
  }
  return probe.stdout.toString()
}

function installedVersion(name: string): string {
  const path = require.resolve(`${name}/package.json`, {
    paths: [ROOT],
  })
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version
}

describe("published package", () => {
  let consumer: string

  beforeAll(() => {
    consumer = mkdtempSync(join(tmpdir(), "next-with-text-package-"))
    const tarball =
      process.env.NEXT_WITH_TEXT_TARBALL ?? join(consumer, "package.tgz")
    if (!process.env.NEXT_WITH_TEXT_TARBALL) {
      // The test command already built dist; packing must not rebuild shared files.
      run(
        ["bun", "pm", "pack", "--ignore-scripts", "--filename", tarball],
        ROOT
      )
    }
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        dependencies: {
          "@types/node": installedVersion("@types/node"),
          "@types/react": "19.2.18",
          next: installedVersion("next"),
          "next-with-text": tarball,
          react: installedVersion("react"),
          "react-dom": installedVersion("react-dom"),
          typescript: installedVersion("typescript"),
        },
        private: true,
      })
    )
    run(["bun", "install", "--ignore-scripts"], consumer)
    mkdirSync(join(consumer, "app"))
  }, 120_000)

  afterAll(() => {
    if (consumer) {
      rmSync(consumer, { force: true, recursive: true })
    }
  })

  for (const format of ["esm", "cjs"] as const) {
    test(`Node ${format} imports both public entrypoints and converts lazily`, () => {
      const entry =
        format === "esm"
          ? `import entry, { withText, convertHTMLtoMarkdown, ConverterUnavailableError } from "next-with-text"
import { createHandler } from "next-with-text/route"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)`
          : `const entry = require("next-with-text")
const { withText, convertHTMLtoMarkdown, ConverterUnavailableError } = entry
const { createHandler } = require("next-with-text/route")`
      const file = join(consumer, format === "esm" ? "probe.mjs" : "probe.cjs")
      writeFileSync(
        file,
        `${entry}
const loaded = () => Object.keys(require.cache).some((file) => file.includes("html-to-markdown"))
const eager = loaded()
Promise.all([
  withText()('phase-production-server', {}),
  convertHTMLtoMarkdown(${JSON.stringify(SAMPLE_HTML)})
]).then(([config, result]) => console.log(JSON.stringify({
  content: result.content,
  eager,
  lazy: loaded(),
  error: typeof ConverterUnavailableError,
  sameEntry: entry.withText === withText,
  route: typeof createHandler,
  external: config.serverExternalPackages.includes("@xberg-io/html-to-markdown")
})))`
      )
      const output = JSON.parse(run(["node", file], consumer)) as {
        content: string
        eager: boolean
        lazy: boolean
        error: string
        route: string
        sameEntry: boolean
        external: boolean
      }
      expect(output.eager).toBe(false)
      expect(output.lazy).toBe(true)
      expect(output.error).toBe("function")
      expect(output.route).toBe("function")
      expect(output.sameEntry).toBe(true)
      expect(output.external).toBe(true)
      expect(output.content).toStartWith(
        "---\ntitle: Setup\nmeta-description: How to install\n---\n"
      )
      expect(output.content).toContain("# Setup")
      expect(output.content).toContain("![Diagram](/diagram.png)")
      expect(output.content).not.toContain("data:image")
      expect(output.content).not.toContain("svg")
      expect(output.content).not.toContain("Copyright")
      expect(output.content).not.toContain("viewport")
    })
  }

  test("published declarations typecheck in ESM and CommonJS consumers", () => {
    const source = `import { withText, convertHTMLtoMarkdown, type MarkdownPage } from "next-with-text"
import { createHandler } from "next-with-text/route"
const md: MarkdownPage<"/tags/[tag]"> = async ({ params }) => (await params).tag
withText({}, { llmstxt: ({ title }) => title })
convertHTMLtoMarkdown("<h1>Setup</h1>").then(({ content }) => content?.toUpperCase())
createHandler({ include: ["**/*"], exclude: [], md: true, dev: false })
void md
`
    for (const extension of ["mts", "cts"]) {
      writeFileSync(join(consumer, `consumer.${extension}`), source)
    }
    // Next's own declarations currently fail strict checking (including missing
    // bundled satori types). Check our published declarations without hiding
    // their errors behind skipLibCheck or adopting Next's internal diagnostics.
    const probe = join(consumer, "types.cjs")
    writeFileSync(
      probe,
      `const ts = require("typescript")
const path = require("node:path")
const program = ts.createProgram(["consumer.mts", "consumer.cts"], {
  noEmit: true,
  strict: true,
  skipLibCheck: false,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext
})
const diagnostics = ts.getPreEmitDiagnostics(program).filter(({ file }) =>
  !file || file.fileName.includes("/node_modules/next-with-text/") ||
  path.dirname(file.fileName) === process.cwd()
)
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\\n"
  }))
  process.exitCode = 1
}`
    )
    run(["node", probe], consumer)
  }, 30_000)

  test("a missing converter doesn't break config or excluded routes", () => {
    const converter = join(
      consumer,
      "node_modules",
      "@xberg-io",
      "html-to-markdown"
    )
    const unavailable = `${converter}.unavailable`
    renameSync(converter, unavailable)
    try {
      const output = run(
        [
          "node",
          "--input-type=module",
          "-e",
          `import { withText, convertHTMLtoMarkdown, ConverterUnavailableError } from "next-with-text"
import { createHandler } from "next-with-text/route"
await withText()('phase-production-server', {})
const handle = createHandler({ include: ["**/*"], exclude: ["**/*"], md: true, dev: false })
const response = await handle(new Request("http://localhost/excluded.md"), { params: Promise.resolve({ path: ["excluded.md"] }) })
try {
  await convertHTMLtoMarkdown("<h1>Setup</h1>")
  throw new Error("conversion unexpectedly succeeded")
} catch (error) {
  if (!(error instanceof ConverterUnavailableError)) throw error
}
console.log(response.status)`,
        ],
        consumer
      )
      expect(output).toBe("404\n")
    } finally {
      renameSync(unavailable, converter)
    }
  })
})
