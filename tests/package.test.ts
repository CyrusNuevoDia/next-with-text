import { describe, expect, test } from "bun:test"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "bun"

const ROOT = join(import.meta.dir, "..")
const manifest = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8")
) as { dependencies: Record<string, string> }
const SAMPLE_HTML = `<html><head><title>Setup</title><meta name="description" content="How to install"><meta name="viewport" content="width=device-width"></head><body><main><h1>Setup</h1><p>Install it.</p><svg><path d="M0 0"/></svg><img alt="Pixel" src="data:image/png;base64,AAAA"><img alt="Diagram" src="/diagram.png"></main><footer>Copyright</footer></body></html>`

describe("published package", () => {
  test("resolves its build helper relative to the installed CJS bundle", () => {
    const consumer = mkdtempSync(join(tmpdir(), "next-with-text-package-"))
    const installed = join(consumer, "node_modules", "next-with-text")
    mkdirSync(installed, { recursive: true })
    cpSync(join(ROOT, "dist"), join(installed, "dist"), { recursive: true })
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ main: "dist/index.cjs" })
    )
    mkdirSync(join(consumer, "app"))
    // The bundle leaves its dependencies external, so give the consumer the
    // ones a real install would put beside the package.
    for (const dependency of Object.keys(manifest.dependencies)) {
      const link = join(consumer, "node_modules", dependency)
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(ROOT, "node_modules", dependency), link)
    }

    const bundled = readFileSync(join(installed, "dist", "index.cjs"), "utf8")
    expect(bundled).not.toContain(join(ROOT, "src"))

    // The probe prints once the config resolves: Bun before 1.4 exited 0 from
    // `-e` when a require failed, so the exit code alone proves nothing.
    const probe = spawnSync(
      [
        "node",
        "-e",
        "require('next-with-text').withText()('phase-production-build', {}).then(() => console.log('configured'))",
      ],
      { cwd: consumer, env: { ...process.env, CI: "" } }
    )
    expect(probe.stderr.toString()).toBe("")
    expect(probe.stdout.toString()).toBe("configured\n")
    expect(probe.exitCode).toBe(0)
  })

  test("exports the converter from the package entry without loading it eagerly", () => {
    const consumer = mkdtempSync(join(tmpdir(), "next-with-text-package-"))
    const scope = join(consumer, "node_modules")
    mkdirSync(scope, { recursive: true })
    symlinkSync(ROOT, join(scope, "next-with-text"))

    const probe = spawnSync(
      [
        "node",
        "-e",
        `const { convertHTMLtoMarkdown, ConverterUnavailableError } = require("next-with-text")
const loaded = () => Object.keys(require.cache).some((file) => file.includes("html-to-markdown"))
const eager = loaded()
convertHTMLtoMarkdown(${JSON.stringify(SAMPLE_HTML)}).then((result) => {
  console.log(JSON.stringify({
    content: result.content,
    eager,
    error: typeof ConverterUnavailableError,
    lazy: loaded(),
  }))
})`,
      ],
      { cwd: consumer }
    )
    expect(probe.stderr.toString()).toBe("")
    const output = JSON.parse(probe.stdout.toString()) as {
      content: string
      eager: boolean
      error: string
      lazy: boolean
    }
    expect(output.eager).toBe(false)
    expect(output.lazy).toBe(true)
    expect(output.error).toBe("function")
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
})
