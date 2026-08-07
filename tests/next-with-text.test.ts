// Verifier suite for docs/shaping.md's checks. Order matters: the dev-serving checks run
// first (they need a fixture with no build artifacts), then `next build` + file
// checks, then `next start` + HTTP checks, then the alternate-config
// `llmstxt` build (it clobbers the main build's output, so it goes last).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"

setDefaultTimeout(240_000)

const ROOT = join(import.meta.dir, "..")
const FIXTURE = join(ROOT, "tests", "fixtures", "next")
const NEXT_BIN = join(FIXTURE, "node_modules", ".bin", "next")
const PUBLIC = join(FIXTURE, "public")

const DEV_PORT = 4311
const START_PORT = 4312

const GENERATED = [
  "index.md",
  "about.md",
  "plain.md",
  "zebra.md",
  "blog/hello.md",
  "docs/api/auth.md",
  "docs/api/tokens.md",
  "docs/getting-started.md",
  "tags/alpha.md",
  "tags/beta.md",
  "llms.txt",
  "llms-full.txt",
]

// routes that must never produce a public file
const NEVER_GENERATED = ["docs/internal/secrets.md", "account.md", "admin.md", "echo.md"]

function cleanFixture(): void {
  rmSync(join(FIXTURE, ".next"), { recursive: true, force: true })
  rmSync(join(FIXTURE, "app", "%5Fllms"), { recursive: true, force: true })
  for (const rel of [...GENERATED, ...NEVER_GENERATED]) {
    rmSync(join(PUBLIC, rel), { force: true })
  }
  for (const dir of ["tags", "blog", "docs"]) {
    rmSync(join(PUBLIC, dir), { recursive: true, force: true })
  }
}

async function ensureToolchain(): Promise<void> {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: ROOT })
  if (build.exitCode !== 0) throw new Error(`library build failed:\n${build.stderr.toString()}`)
  if (!existsSync(join(FIXTURE, "node_modules"))) {
    const install = Bun.spawnSync(["bun", "install"], { cwd: FIXTURE })
    if (install.exitCode !== 0) throw new Error(`fixture install failed:\n${install.stderr.toString()}`)
  }
  const link = join(FIXTURE, "node_modules", "next-with-text")
  if (!existsSync(link)) symlinkSync(join("..", "..", "..", ".."), link)
}

async function buildFixture(env: Record<string, string> = {}): Promise<void> {
  const proc = Bun.spawn([NEXT_BIN, "build"], {
    cwd: FIXTURE,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if ((await proc.exited) !== 0) throw new Error(`next build failed:\n${out}\n${err}`)
}

type Server = { stop: () => Promise<void>; logs: () => string }

async function startServer(args: string[], port: number): Promise<Server> {
  // a stale server on the port makes every assertion meaningless — fail loudly
  const squatter = Bun.spawnSync(["lsof", "-ti", `:${port}`])
  if (squatter.stdout.toString().trim() !== "") {
    throw new Error(`port ${port} is already in use: pid(s) ${squatter.stdout.toString().trim()}`)
  }

  const proc = Bun.spawn([NEXT_BIN, ...args, "-p", String(port)], {
    cwd: FIXTURE,
    stdout: "pipe",
    stderr: "pipe",
  })
  let logs = ""
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk)
  }
  capture(proc.stdout)
  capture(proc.stderr)

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}):\n${logs}`)
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2_000) })
      break
    } catch {
      await Bun.sleep(500)
    }
  }

  return {
    logs: () => logs,
    stop: async () => {
      proc.kill()
      await Promise.race([proc.exited, Bun.sleep(5_000).then(() => proc.kill(9))])
    },
  }
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, { headers, redirect: "manual" })
}

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"

// asserts a < b < c ... by first occurrence in body
function assertOrder(body: string, ...needles: string[]): void {
  const positions = needles.map((n) => {
    const at = body.indexOf(n)
    expect(`${at >= 0} ${n}`).toBe(`true ${n}`)
    return at
  })
  for (let i = 1; i < positions.length; i++) {
    expect(positions[i]).toBeGreaterThan(positions[i - 1])
  }
}

// ---------------------------------------------------------------------------
// Amended check 14 + on-demand halves of 22/25 — dev serving via the
// generated route, no build artifacts
// ---------------------------------------------------------------------------

describe("next dev", () => {
  let server: Server

  beforeAll(async () => {
    await ensureToolchain()
    cleanFixture()
    server = await startServer(["dev"], DEV_PORT)
  })

  afterAll(async () => {
    await server?.stop()
  })

  test("GET /llms.txt returns the sectioned index", async () => {
    const res = await get(DEV_PORT, "/llms.txt")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("# Fixture Site")
    expect(body).toContain("> A test site.")
    expect(body).toContain("](/about.md)")
    expect(body).toContain("## Docs")
    expect(body).not.toContain("## Pages")
  })

  test("md export wins on demand: /about.md serves the override", async () => {
    const res = await get(DEV_PORT, "/about.md")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("MD_OVERRIDE_ABOUT")
  })

  test("converted page serves markdown with image references", async () => {
    const res = await get(DEV_PORT, "/docs/getting-started.md")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("SENTINEL_GETTING_STARTED")
    expect(body).toContain("![The team](/images/team.png)")
    expect(body).not.toContain("<article")
    expect(body).not.toContain("data:image")
  })

  test("Accept: text/markdown negotiates markdown", async () => {
    const res = await get(DEV_PORT, "/docs/getting-started", { accept: "text/markdown" })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("SENTINEL_GETTING_STARTED")
    expect(body).not.toContain("<article")
  })

  test("cookie-aware /account.md in dev", async () => {
    const anonymous = await get(DEV_PORT, "/account.md")
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).toContain("session=none")

    const authed = await get(DEV_PORT, "/account.md", { cookie: "session=abc123" })
    expect(await authed.text()).toContain("session=abc123")
  })

  test("check 24 (dev): params reach the md function", async () => {
    expect(await (await get(DEV_PORT, "/tags/alpha.md")).text()).toContain("MD_TAG_alpha")
  })

  test("check 25 (dev): searchParams reach the md function", async () => {
    expect(await (await get(DEV_PORT, "/echo.md?q=xyz")).text()).toContain("MD_ECHO_xyz")
    expect(await (await get(DEV_PORT, "/echo.md")).text()).toContain("MD_ECHO_none")
  })

  test("check 22 (dev): excluded routes 404 on the on-demand tier", async () => {
    expect((await get(DEV_PORT, "/docs/internal/secrets.md")).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Amended checks 1–12 + new 17–22, 24 — `next build` generates the static
// surfaces inside the build
// ---------------------------------------------------------------------------

describe("next build", () => {
  beforeAll(async () => {
    cleanFixture()
    await buildFixture()
  })

  const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8")

  test("check 1: every included prerendered page got its file, nothing else", () => {
    for (const rel of GENERATED) expect(existsSync(join(PUBLIC, rel))).toBe(true)
    for (const rel of NEVER_GENERATED) expect(existsSync(join(PUBLIC, rel))).toBe(false)
  })

  test("check 2: llms.txt template — header, then unheaded root links", () => {
    expect(read("llms.txt")).toStartWith(
      "# Fixture Site\n\n> A test site.\n\n- [Fixture Site](/index.md): A test site.\n",
    )
  })

  test("check 3: links derive from rendered metadata; every line well-formed", () => {
    const body = read("llms.txt")
    expect(body).toContain("- [About Us | Fixture Site](/about.md): Who we are and why.")
    expect(body).toContain("- [Post: hello | Fixture Site](/blog/hello.md): Blog post about hello.")
    expect(body).toContain(
      "- [Getting Started | Fixture Site](/docs/getting-started.md): How to get started with the fixture.",
    )
    expect(body).toContain("- [Tag: alpha | Fixture Site](/tags/alpha.md): Pages tagged alpha.")
    // every link line is `- [title](/route.md): description`
    for (const line of body.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).toMatch(/^- \[.+\]\(\/[^)]+\.md\): .+$/)
    }
  })

  test("check 21: path-segment sections — root unheaded, depth-1 grouping, alphabetical", () => {
    const body = read("llms.txt")
    assertOrder(
      body,
      "(/index.md)",
      "(/about.md)",
      "(/plain.md)",
      "(/zebra.md)",
      "## Blog",
      "(/blog/hello.md)",
      "## Docs",
      "(/docs/api/auth.md)",
      "(/docs/api/tokens.md)",
      "(/docs/getting-started.md)",
      "## Tags",
      "(/tags/alpha.md)",
      "(/tags/beta.md)",
    )
    // root links come before any section heading
    expect(body.indexOf("(/zebra.md)")).toBeLessThan(body.indexOf("## "))
    // depth-2 routes never make subsections
    expect(body).not.toContain("## Api")
    expect(body).not.toContain("## Docs / Api")
  })

  test("check 18: object-form md overrides the index entry", () => {
    const body = read("llms.txt")
    expect(body).toContain("- [MD_TITLE_TOKENS](/docs/api/tokens.md): MD_DESC_TOKENS")
    expect(body).not.toContain("OG_TITLE_TOKENS")
    // string-form pages keep rendered metadata
    expect(body).toContain("- [About Us | Fixture Site](/about.md): Who we are and why.")
  })

  test("check 19: plain-value md export — entry and content", () => {
    expect(read("llms.txt")).toContain("- [MD_TITLE_PLAIN](/plain.md): MD_DESC_PLAIN")
    expect(read("plain.md")).toContain("MD_CONTENT_PLAIN")
  })

  test("check 17: object-form md content wins in the .md twin and llms-full", () => {
    expect(read("docs/api/tokens.md")).toContain("MD_CONTENT_TOKENS")
    expect(read("llms-full.txt")).toContain("MD_CONTENT_TOKENS")
    expect(read("llms-full.txt")).not.toContain("SENTINEL_TOKENS")
  })

  test("check 24: one md call per generateStaticParams instance, each with its params", () => {
    expect(read("tags/alpha.md")).toContain("MD_TAG_alpha")
    expect(read("tags/beta.md")).toContain("MD_TAG_beta")
  })

  test("check 4 (amended): llms-full.txt — header then every included page, no preamble", () => {
    const body = read("llms-full.txt")
    expect(body).toStartWith("# Fixture Site\n\n> A test site.\n")
    expect(body).not.toContain("CUSTOM_PREAMBLE")
    for (const present of [
      "SENTINEL_HOME",
      "MD_OVERRIDE_ABOUT",
      "MD_CONTENT_PLAIN",
      "SENTINEL_ZEBRA",
      "SENTINEL_BLOG_HELLO",
      "SENTINEL_API_AUTH",
      "MD_CONTENT_TOKENS",
      "SENTINEL_GETTING_STARTED",
      "MD_TAG_alpha",
      "MD_TAG_beta",
    ]) {
      expect(body).toContain(present)
    }
    for (const absent of [
      "SENTINEL_SECRETS",
      "SENTINEL_ACCOUNT",
      "SENTINEL_ADMIN",
      "SENTINEL_ECHO",
      "SENTINEL_ABOUT",
      "SENTINEL_TOKENS",
    ]) {
      expect(body).not.toContain(absent)
    }
  })

  test("check 5: llms-full sections are markdown — no HTML, no RSC, no frontmatter", () => {
    const body = read("llms-full.txt")
    expect(body).not.toContain("<article")
    expect(body).not.toContain("<script")
    expect(body).not.toContain("self.__next")
    expect(body).not.toContain("\n---\ntitle:")
    expect(body).not.toContain("meta-description:")
  })

  test("check 9 (amended): image references are real URLs, no data: URIs anywhere", () => {
    expect(read("docs/getting-started.md")).toContain("![The team](/images/team.png)")
    for (const rel of GENERATED) expect(read(rel)).not.toContain("data:image")
  })

  test("check 20: txt is gone — no .txt output besides the llms surfaces", () => {
    const txtFiles = readdirSync(PUBLIC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".txt"))
      .sort()
    expect(txtFiles).toEqual(["llms-full.txt", "llms.txt"])
  })

  test("check 22: shared exclude scrubs /docs/internal/** from every surface", () => {
    expect(existsSync(join(PUBLIC, "docs/internal/secrets.md"))).toBe(false)
    for (const rel of GENERATED) expect(read(rel)).not.toContain("SENTINEL_SECRETS")
    expect(read("llms.txt")).not.toContain("/docs/internal/")
  })

  test("check 11: dynamic authed /account leaks into nothing", () => {
    for (const rel of GENERATED) expect(read(rel)).not.toContain("SENTINEL_ACCOUNT")
    expect(read("llms.txt")).not.toContain("/account.md")
  })

  test("check 12: proxy-matcher auto-exclusion removes static /admin from every surface", () => {
    for (const rel of GENERATED) expect(read(rel)).not.toContain("SENTINEL_ADMIN")
    expect(read("llms.txt")).not.toContain("/admin.md")
  })
})

// ---------------------------------------------------------------------------
// Amended checks 2/4/6/7/8/13 + new 20/22/25 over HTTP — `next start`
// serves files + on-demand tier
// ---------------------------------------------------------------------------

describe("next start", () => {
  let server: Server

  beforeAll(async () => {
    server = await startServer(["start"], START_PORT)
  })

  afterAll(async () => {
    await server?.stop()
  })

  test("llms surfaces serve over HTTP", async () => {
    const index = await get(START_PORT, "/llms.txt")
    expect(index.status).toBe(200)
    expect(await index.text()).toStartWith("# Fixture Site\n\n> A test site.\n\n- [")

    const full = await get(START_PORT, "/llms-full.txt")
    expect(full.status).toBe(200)
    expect(await full.text()).toContain("SENTINEL_HOME")
  })

  test("check 6/7: .md twins serve, unknown .md 404s", async () => {
    expect(await (await get(START_PORT, "/about.md")).text()).toContain("MD_OVERRIDE_ABOUT")
    expect(await (await get(START_PORT, "/docs/getting-started.md")).text()).toContain(
      "SENTINEL_GETTING_STARTED",
    )
    expect(await (await get(START_PORT, "/zebra.md")).text()).toContain("SENTINEL_ZEBRA")
    expect(await (await get(START_PORT, "/plain.md")).text()).toContain("MD_CONTENT_PLAIN")
    expect(await (await get(START_PORT, "/tags/alpha.md")).text()).toContain("MD_TAG_alpha")
    expect((await get(START_PORT, "/nonexistent.md")).status).toBe(404)
  })

  test("check 8: Accept negotiation — markdown clients get markdown, browsers get HTML", async () => {
    const markdown = await get(START_PORT, "/docs/getting-started", { accept: "text/markdown" })
    const markdownBody = await markdown.text()
    expect(markdownBody).toContain("SENTINEL_GETTING_STARTED")
    expect(markdownBody).not.toContain("<article")

    const browser = await get(START_PORT, "/docs/getting-started", { accept: BROWSER_ACCEPT })
    const browserBody = await browser.text()
    expect(browserBody).toContain("<!DOCTYPE html>")
    expect(browserBody).toContain("SENTINEL_GETTING_STARTED")
  })

  test("check 20: no txt surface — .txt 404s, text/plain is not negotiated", async () => {
    expect((await get(START_PORT, "/about.txt")).status).toBe(404)
    const plain = await get(START_PORT, "/about", { accept: "text/plain" })
    expect(await plain.text()).toContain("<!DOCTYPE html>")
  })

  test("check 22: excluded routes 404 on the on-demand tier", async () => {
    expect((await get(START_PORT, "/docs/internal/secrets.md")).status).toBe(404)
  })

  test("check 25: searchParams reach the md function on demand", async () => {
    const withQuery = await get(START_PORT, "/echo.md?q=xyz")
    expect(withQuery.status).toBe(200)
    expect(await withQuery.text()).toContain("MD_ECHO_xyz")
    expect(await (await get(START_PORT, "/echo.md")).text()).toContain("MD_ECHO_none")
  })

  test("check 13: on-demand cookie-aware conversion of the dynamic /account page", async () => {
    const anonymous = await get(START_PORT, "/account.md")
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).toContain("session=none")

    const authed = await get(START_PORT, "/account.md", { cookie: "session=abc123" })
    expect(await authed.text()).toContain("session=abc123")

    const negotiated = await get(START_PORT, "/account", {
      accept: "text/markdown",
      cookie: "session=abc123",
    })
    const negotiatedBody = await negotiated.text()
    expect(negotiatedBody).toContain("session=abc123")
    expect(negotiatedBody).not.toContain("<article")
  })

  test("proxy-guarded /admin.md stays gated on demand", async () => {
    expect((await get(START_PORT, "/admin.md")).status).toBe(404)
    const authed = await get(START_PORT, "/admin.md", { cookie: "session=abc123" })
    expect(await authed.text()).toContain("SENTINEL_ADMIN")
  })
})

// ---------------------------------------------------------------------------
// Check 23 — the `llmstxt` function owns the entire llms.txt body.
// Runs last: it rebuilds the fixture with LLMSTXT_FN=1.
// ---------------------------------------------------------------------------

describe("llmstxt function build", () => {
  beforeAll(async () => {
    cleanFixture()
    await buildFixture({ LLMSTXT_FN: "1" })
  })

  const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8")

  test("check 23: the function's return is the entire llms.txt body", () => {
    const body = read("llms.txt")
    expect(body).toStartWith("LLMSTXT_FN:Fixture Site:A test site.")
    expect(body).not.toContain("## ")
  })

  test("check 23: ctx.routes is flat, hrefs are .md, index precedence applied", () => {
    const body = read("llms.txt")
    expect(body).toContain("ROUTE:MD_TITLE_TOKENS|/docs/api/tokens.md|MD_DESC_TOKENS")
    expect(body).toContain("ROUTE:MD_TITLE_PLAIN|/plain.md|MD_DESC_PLAIN")
    expect(body).toContain("ROUTE:About Us | Fixture Site|/about.md|Who we are and why.")
    // filters and auth exclusion still applied to ctx.routes
    expect(body).not.toContain("/docs/internal/")
    expect(body).not.toContain("/account.md")
    expect(body).not.toContain("/admin.md")
  })

  test("check 23: llms-full.txt is unaffected by the function", () => {
    const body = read("llms-full.txt")
    expect(body).toStartWith("# Fixture Site")
    expect(body).not.toContain("LLMSTXT_FN")
    expect(body).toContain("MD_CONTENT_TOKENS")
  })
})
