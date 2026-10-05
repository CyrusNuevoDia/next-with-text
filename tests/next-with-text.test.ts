// Verifier suite for docs/shaping.md's checks. Order matters: the dev-serving checks run
// first (they need a fixture with no build artifacts), then `next build` + file
// checks, then `next start` + HTTP checks, then the alternate-config
// `llmstxt` build (it clobbers the main build's output, so it goes last), and
// finally the local (non-deploy) build, which needs the previous build's
// output to prove it reclaims it.
//
// Careful with `bun test -t "…"`: filtering skips tests but still runs every
// describe's beforeAll, so another describe's cleanFixture() can produce the
// state your filtered test asserts. A filtered green is not a green — this
// suite has already handed out one false pass that way.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { sleep, spawn, spawnSync } from "bun"

setDefaultTimeout(240_000)

const ROOT = join(import.meta.dir, "..")
const FIXTURE = join(ROOT, "tests", "fixtures", "next")
const NEXT_BIN = join(FIXTURE, "node_modules", ".bin", "next")
const PUBLIC = join(FIXTURE, "public")

const DEV_PORT = 4311
const START_PORT = 4312
const LOCAL_START_PORT = 4313
const CUSTOM_START_PORT = 4314
const BUNDLE_PORT = 4315
const INDEX_LINK = /^- \[.+\]\(\/[^)]+\.md\): .+$/

// the prune ownership probe: a generated file the user edits afterwards must
// survive the local build that reclaims everything else
const HAND_EDITED = "docs/api/auth.md"
const HAND_EDIT = "hand-edited, not ours to delete\n"
const STALE_GATED = "STALE_GATED: captured render\n"

const GENERATED = [
  "index.md",
  "about.md",
  "plain.md",
  "zebra.md",
  "blog/hello.md",
  "docs/api/auth.md",
  "docs/api/tokens.md",
  "docs/getting-started.md",
  "admin/reports.md",
  "tags/alpha.md",
  "tags/beta.md",
  "llms.txt",
  "llms-full.txt",
]

// routes that must never produce a public file — including /gated, which opts
// into the index but declares no body, so it stays live and cookie-aware
const NEVER_GENERATED = [
  "docs/internal/secrets.md",
  "account.md",
  "admin.md",
  "echo.md",
  "gated.md",
]

function cleanFixture(): void {
  rmSync(join(FIXTURE, ".next"), { force: true, recursive: true })
  rmSync(join(FIXTURE, "app", "%5Fllms"), { force: true, recursive: true })
  rmSync(join(FIXTURE, "app", "llms-full.txt"), {
    force: true,
    recursive: true,
  })
  rmSync(join(FIXTURE, "app", "about.md"), {
    force: true,
    recursive: true,
  })
  rmSync(join(FIXTURE, "adapter-probe.json"), { force: true })
  rmSync(join(FIXTURE, "llmstxt-invoked"), { force: true })
  rmSync(join(FIXTURE, "llmsfulltxt-invoked"), { force: true })
  for (const rel of [...GENERATED, ...NEVER_GENERATED]) {
    rmSync(join(PUBLIC, rel), { force: true })
  }
  for (const dir of ["tags", "blog", "docs", "admin"]) {
    rmSync(join(PUBLIC, dir), { force: true, recursive: true })
  }
}

function ensureToolchain(): void {
  const build = spawnSync(["bun", "run", "build"], { cwd: ROOT })
  if (build.exitCode !== 0) {
    throw new Error(`library build failed:\n${build.stderr.toString()}`)
  }
  if (!existsSync(join(FIXTURE, "node_modules"))) {
    const install = spawnSync(["bun", "install"], { cwd: FIXTURE })
    if (install.exitCode !== 0) {
      throw new Error(`fixture install failed:\n${install.stderr.toString()}`)
    }
  }
  const link = join(FIXTURE, "node_modules", "next-with-text")
  if (!existsSync(link)) {
    symlinkSync(join("..", "..", "..", ".."), link)
  }
}

// CI=1 makes the build deploy-shaped (static tier written to public/) no
// matter where the suite runs; the local-build describe overrides it away.
async function buildFixture(env: Record<string, string> = {}): Promise<void> {
  const proc = spawn([NEXT_BIN, "build"], {
    cwd: FIXTURE,
    env: { ...process.env, CI: "1", ...env },
    stderr: "pipe",
    stdout: "pipe",
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if ((await proc.exited) !== 0) {
    throw new Error(`next build failed:\n${out}\n${err}`)
  }
}

type Server = {
  logs: () => string
  stop: () => Promise<void>
}

function startServer(args: string[], port: number): Promise<Server> {
  return launch([NEXT_BIN, ...args, "-p", String(port)], FIXTURE, port)
}

async function launch(
  cmd: string[],
  cwd: string,
  port: number
): Promise<Server> {
  // a stale server on the port makes every assertion meaningless — fail loudly
  const squatter = spawnSync(["lsof", "-ti", `:${port}`])
  if (squatter.stdout.toString().trim() !== "") {
    throw new Error(
      `port ${port} is already in use: pid(s) ${squatter.stdout.toString().trim()}`
    )
  }

  const proc = spawn(cmd, {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stderr: "pipe",
    stdout: "pipe",
  })
  let logs = ""
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      logs += new TextDecoder().decode(chunk)
    }
  }
  capture(proc.stdout)
  capture(proc.stderr)

  await pollUntil(
    async () => {
      if (proc.exitCode !== null) {
        throw new Error(`server exited early (${proc.exitCode}):\n${logs}`)
      }
      try {
        await fetch(`http://localhost:${port}/`, {
          signal: AbortSignal.timeout(2000),
        })
        return true
      } catch {
        return false
      }
    },
    Date.now() + 120_000,
    500
  )

  return {
    logs: () => logs,
    stop: async () => {
      proc.kill()
      await Promise.race([proc.exited, sleep(5000).then(() => proc.kill(9))])
    },
  }
}

async function pollUntil(
  condition: () => boolean | Promise<boolean>,
  deadline: number,
  interval: number
): Promise<boolean> {
  if (await condition()) {
    return true
  }
  if (Date.now() >= deadline) {
    return false
  }
  await sleep(interval)
  return pollUntil(condition, deadline, interval)
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    headers,
    redirect: "manual",
  })
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
  for (let i = 1; i < positions.length; i += 1) {
    expect(positions[i]).toBeGreaterThan(positions[i - 1] ?? -1)
  }
}

// ---------------------------------------------------------------------------
// Amended check 14 + on-demand halves of 22/25 — dev serving via the
// generated route, no build artifacts
// ---------------------------------------------------------------------------

describe("next dev", () => {
  let server: Server

  beforeAll(async () => {
    ensureToolchain()
    cleanFixture()
    server = await startServer(["dev"], DEV_PORT)
  })

  afterAll(async () => {
    await server.stop()
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
    expect(body).not.toContain("Inline avatar")
    expect(body).not.toContain("Missing source")
    expect(body).not.toContain("SVG Image")
    expect(body).not.toContain("<article")
    expect(body).not.toContain("data:image")
  })

  test("converted page frontmatter contains only title then description", async () => {
    const res = await get(DEV_PORT, "/docs/getting-started.md")
    expect(res.status).toBe(200)
    const frontmatter = (await res.text()).split("---", 3)[1]?.trim()
    expect(frontmatter).toBe(
      "title: Getting Started | Fixture Site\nmeta-description: How to get started with the fixture."
    )
  })

  test("Accept: text/markdown negotiates markdown", async () => {
    const res = await get(DEV_PORT, "/docs/getting-started", {
      accept: "text/markdown",
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("SENTINEL_GETTING_STARTED")
    expect(body).not.toContain("<article")
  })

  test("cookie-aware /account.md in dev", async () => {
    const anonymous = await get(DEV_PORT, "/account.md")
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).toContain("session=none")

    const authed = await get(DEV_PORT, "/account.md", {
      cookie: "session=abc123",
    })
    expect(await authed.text()).toContain("session=abc123")
  })

  test("dev agrees with the build on what a gated opt-in publishes", async () => {
    const index = await (await get(DEV_PORT, "/llms.txt")).text()
    expect(index).toContain("- [MD_TITLE_GATED](/gated.md): MD_DESC_GATED")

    const full = await (await get(DEV_PORT, "/llms-full.txt")).text()
    expect(full).toContain(
      "# MD_TITLE_GATED\n\n> MD_DESC_GATED\n\n[Requires session](/gated.md)"
    )
    // dev renders the page happily for a signed-out visitor; the point is that
    // the surface still refuses to inline it
    expect(full).not.toContain("SENTINEL_GATED")
  })

  test("check 24 (dev): params reach the md function", async () => {
    expect(await (await get(DEV_PORT, "/tags/alpha.md")).text()).toContain(
      "MD_TAG_alpha"
    )
  })

  test("check 25 (dev): searchParams reach the md function", async () => {
    expect(await (await get(DEV_PORT, "/echo.md?q=xyz")).text()).toContain(
      "MD_ECHO_xyz"
    )
    expect(await (await get(DEV_PORT, "/echo.md")).text()).toContain(
      "MD_ECHO_none"
    )
  })

  test("check 22 (dev): excluded routes 404 on the on-demand tier", async () => {
    expect((await get(DEV_PORT, "/docs/internal/secrets.md")).status).toBe(404)
  })

  test("a concurrent next build leaves the running dev server's route intact", async () => {
    await buildFixture({ CI: "" })
    expect(existsSync(join(FIXTURE, "app", "%5Fllms"))).toBe(true)
    const res = await get(DEV_PORT, "/llms.txt")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("](/about.md)")
  })

  // runs last in this describe: it shuts the server down
  test("stopping the dev server removes the generated route and scrubs dev typegen", async () => {
    const routeDir = join(FIXTURE, "app", "%5Fllms")
    expect(existsSync(routeDir)).toBe(true) // dev compiles from source — it must exist while serving
    await server.stop()
    await pollUntil(() => !existsSync(routeDir), Date.now() + 10_000, 200)
    expect(existsSync(routeDir)).toBe(false)
    const devValidator = join(FIXTURE, ".next", "dev", "types", "validator.ts")
    if (existsSync(devValidator)) {
      expect(readFileSync(devValidator, "utf8")).not.toContain("%5Fllms")
    }
  })
})

// ---------------------------------------------------------------------------
// Amended checks 1–12 + new 17–22, 24 — `next build` generates the static
// surfaces inside the build
// ---------------------------------------------------------------------------

describe("next build", () => {
  beforeAll(async () => {
    cleanFixture()
    // what an earlier build would have left at a route that now publishes no
    // body — it must be reclaimed, or it shadows the live per-requester render
    mkdirSync(PUBLIC, { recursive: true })
    writeFileSync(join(PUBLIC, "gated.md"), STALE_GATED)
    const manifestDir = join(FIXTURE, ".next", "cache")
    mkdirSync(manifestDir, { recursive: true })
    writeFileSync(
      join(manifestDir, "next-with-text-manifest.json"),
      JSON.stringify({
        "gated.md": createHash("sha256")
          .update(STALE_GATED)
          .digest("hex")
          .slice(0, 16),
      })
    )
    await buildFixture({
      NEXT_ADAPTER_PATH: join(FIXTURE, "adapter-probe.cjs"),
    })
  })

  const read = (rel: string) => readFileSync(join(PUBLIC, rel), "utf8")

  test("the generated app/%5Fllms route remains for deployment collection", () => {
    expect(existsSync(join(FIXTURE, "app", "%5Fllms"))).toBe(true)
  })

  test("the deployment adapter sees the generated route and static files", () => {
    expect(
      JSON.parse(readFileSync(join(FIXTURE, "adapter-probe.json"), "utf8"))
    ).toEqual({ route: true, static: true })
  })

  test("an adapter build publishes from the adapter's prerender outputs, not a dist layout", () => {
    // Since 16.3.8 an adapter build writes its prerendered HTML under
    // .next/server/route-cache, not .next/server/app — walking the latter
    // found nothing and shipped an empty index. The first assertions pin the
    // fixture to that layout so the rest of this suite keeps proving the
    // adapter outputs drive generation.
    const server = join(FIXTURE, ".next", "server")
    expect(existsSync(join(server, "app", "index.html"))).toBe(false)
    expect(existsSync(join(server, "route-cache"))).toBe(true)
    expect(read("llms.txt")).toStartWith("# Fixture Site\n")
    expect(read("index.md")).toContain("title: Fixture Site")
    expect(read("tags/alpha.md")).toContain("MD_TAG_alpha")
  })

  test("typegen keeps its reference to the retained route — tsc stays clean", () => {
    const validator = readFileSync(
      join(FIXTURE, ".next", "types", "validator.ts"),
      "utf8"
    )
    expect(validator).toContain("%5Fllms")
    const tsc = spawnSync(["bunx", "tsc", "--noEmit"], { cwd: FIXTURE })
    expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("")
    expect(tsc.exitCode).toBe(0)
  })

  test("a header-conditional proxy matcher excludes nothing; a path matcher still does", () => {
    // the fixture proxy pairs /admin/:path* with a has: accept matcher on
    // /:path* — only the unconditional one may keep routes out
    const manifest = readFileSync(
      join(FIXTURE, ".next", "server", "functions-config-manifest.json"),
      "utf8"
    )
    expect(manifest).toContain('"has"')
    const index = read("llms.txt")
    expect(index).toContain("](/about.md)")
    expect(index).toContain("](/docs/getting-started.md)")
    for (const rel of GENERATED) {
      expect(`${existsSync(join(PUBLIC, rel))} ${rel}`).toBe(`true ${rel}`)
    }
    expect(index).not.toContain("(/admin.md)")
    expect(existsSync(join(PUBLIC, "admin.md"))).toBe(false)
  })

  test("check 1: every included prerendered page got its file, nothing else", () => {
    for (const rel of GENERATED) {
      expect(existsSync(join(PUBLIC, rel))).toBe(true)
    }
    for (const rel of NEVER_GENERATED) {
      expect(existsSync(join(PUBLIC, rel))).toBe(false)
    }
  })

  test("check 2: llms.txt template — header, then unheaded root links", () => {
    expect(read("llms.txt")).toStartWith(
      "# Fixture Site\n\n> A test site.\n\n- [Fixture Site](/index.md): A test site.\n"
    )
  })

  test("check 3: links derive from rendered metadata; every line well-formed", () => {
    const body = read("llms.txt")
    expect(body).toContain(
      "- [About Us | Fixture Site](/about.md): Who we are and why."
    )
    expect(body).toContain(
      "- [Post: hello | Fixture Site](/blog/hello.md): Blog post about hello."
    )
    expect(body).toContain(
      "- [Getting Started | Fixture Site](/docs/getting-started.md): How to get started with the fixture."
    )
    expect(body).toContain(
      "- [Tag: alpha | Fixture Site](/tags/alpha.md): Pages tagged alpha."
    )
    // every link line is `- [title](/route.md): description`
    for (const line of body.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).toMatch(INDEX_LINK)
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
      "(/tags/beta.md)"
    )
    // root links come before any section heading
    expect(body.indexOf("(/zebra.md)")).toBeLessThan(body.indexOf("## "))
    // depth-2 routes never make subsections
    expect(body).not.toContain("## Api")
    expect(body).not.toContain("## Docs / Api")
  })

  test("check 18: object-form md overrides the index entry", () => {
    const body = read("llms.txt")
    expect(body).toContain(
      "- [MD_TITLE_TOKENS](/docs/api/tokens.md): MD_DESC_TOKENS"
    )
    expect(body).not.toContain("OG_TITLE_TOKENS")
    // string-form pages keep rendered metadata
    expect(body).toContain(
      "- [About Us | Fixture Site](/about.md): Who we are and why."
    )
  })

  test("check 19: plain-value md export — entry and content", () => {
    expect(read("llms.txt")).toContain(
      "- [MD_TITLE_PLAIN](/plain.md): MD_DESC_PLAIN"
    )
    expect(read("plain.md")).toContain("MD_CONTENT_PLAIN")
  })

  test("a stale .md at an opted-in route's path is reclaimed", () => {
    expect(existsSync(join(PUBLIC, "gated.md"))).toBe(false)
    for (const rel of GENERATED) {
      expect(read(rel)).not.toContain("STALE_GATED")
    }
  })

  test("gated dynamic page opts into the index via a content-less md export", () => {
    expect(read("llms.txt")).toContain(
      "- [MD_TITLE_GATED](/gated.md): MD_DESC_GATED"
    )
  })

  test("the opted-in gated route publishes a stub, never its rendering", () => {
    const body = read("llms-full.txt")
    expect(body).toContain(
      "# MD_TITLE_GATED\n\n> MD_DESC_GATED\n\n[Requires session](/gated.md)"
    )
    // the page renders fine for a signed-out visitor — that is exactly what
    // must not be captured into a static file
    expect(body).not.toContain("SENTINEL_GATED")
    expect(body).not.toContain("OG_TITLE_GATED")
    expect(existsSync(join(PUBLIC, "gated.md"))).toBe(false)
  })

  test("proxy-guarded route opts in with content, and only that content ships", () => {
    expect(read("llms.txt")).toContain(
      "- [MD_TITLE_REPORTS](/admin/reports.md): MD_DESC_REPORTS"
    )
    expect(read("admin/reports.md")).toContain("MD_CONTENT_REPORTS")
    const full = read("llms-full.txt")
    expect(full).toContain("MD_CONTENT_REPORTS")
    // the guarded page's own rendering stays out of every surface
    for (const rel of GENERATED) {
      expect(read(rel)).not.toContain("SENTINEL_REPORTS")
    }
    expect(full).not.toContain("OG_TITLE_REPORTS")
    // and the guarded route that did NOT opt in is still absent
    expect(read("llms.txt")).not.toContain("(/admin.md)")
  })

  test("an exclude pattern beats a page's own opt-in", () => {
    const index = read("llms.txt")
    expect(index).not.toContain("MD_TITLE_SECRETS")
    expect(index).not.toContain("/docs/internal/")
    expect(read("llms-full.txt")).not.toContain("MD_TITLE_SECRETS")
    expect(existsSync(join(PUBLIC, "docs/internal/secrets.md"))).toBe(false)
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

  test("converted files contain only title then description in frontmatter", () => {
    const frontmatter = read("docs/getting-started.md")
      .split("---", 3)[1]
      ?.trim()
    expect(frontmatter).toBe(
      "title: Getting Started | Fixture Site\nmeta-description: How to get started with the fixture."
    )
  })

  test("check 9 (amended): image references are real URLs, no data: URIs anywhere", () => {
    const page = read("docs/getting-started.md")
    expect(page).toContain("![The team](/images/team.png)")
    expect(page).not.toContain("Inline avatar")
    expect(page).not.toContain("Missing source")
    expect(page).not.toContain("SVG Image")
    for (const rel of GENERATED) {
      expect(read(rel)).not.toContain("data:image")
    }
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
    for (const rel of GENERATED) {
      expect(read(rel)).not.toContain("SENTINEL_SECRETS")
    }
    expect(read("llms.txt")).not.toContain("/docs/internal/")
  })

  test("check 11: dynamic authed /account leaks into nothing", () => {
    for (const rel of GENERATED) {
      expect(read(rel)).not.toContain("SENTINEL_ACCOUNT")
    }
    expect(read("llms.txt")).not.toContain("/account.md")
  })

  test("check 12: proxy-matcher auto-exclusion removes static /admin from every surface", () => {
    for (const rel of GENERATED) {
      expect(read(rel)).not.toContain("SENTINEL_ADMIN")
    }
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
    await server.stop()
  })

  test("llms surfaces serve over HTTP", async () => {
    const index = await get(START_PORT, "/llms.txt")
    expect(index.status).toBe(200)
    expect(await index.text()).toStartWith(
      "# Fixture Site\n\n> A test site.\n\n- ["
    )

    const full = await get(START_PORT, "/llms-full.txt")
    expect(full.status).toBe(200)
    expect(await full.text()).toContain("SENTINEL_HOME")
  })

  test("check 6/7: .md twins serve, unknown .md 404s", async () => {
    expect(await (await get(START_PORT, "/about.md")).text()).toContain(
      "MD_OVERRIDE_ABOUT"
    )
    expect(
      await (await get(START_PORT, "/docs/getting-started.md")).text()
    ).toContain("SENTINEL_GETTING_STARTED")
    expect(await (await get(START_PORT, "/zebra.md")).text()).toContain(
      "SENTINEL_ZEBRA"
    )
    expect(await (await get(START_PORT, "/plain.md")).text()).toContain(
      "MD_CONTENT_PLAIN"
    )
    expect(await (await get(START_PORT, "/tags/alpha.md")).text()).toContain(
      "MD_TAG_alpha"
    )
    expect((await get(START_PORT, "/nonexistent.md")).status).toBe(404)
  })

  test("check 8: Accept negotiation — markdown clients get markdown, browsers get HTML", async () => {
    const markdown = await get(START_PORT, "/docs/getting-started", {
      accept: "text/markdown",
    })
    const markdownBody = await markdown.text()
    expect(markdownBody).toContain("SENTINEL_GETTING_STARTED")
    expect(markdownBody).not.toContain("<article")

    const browser = await get(START_PORT, "/docs/getting-started", {
      accept: BROWSER_ACCEPT,
    })
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
    expect((await get(START_PORT, "/docs/internal/secrets.md")).status).toBe(
      404
    )
  })

  test("check 25: searchParams reach the md function on demand", async () => {
    const withQuery = await get(START_PORT, "/echo.md?q=xyz")
    expect(withQuery.status).toBe(200)
    expect(await withQuery.text()).toContain("MD_ECHO_xyz")
    expect(await (await get(START_PORT, "/echo.md")).text()).toContain(
      "MD_ECHO_none"
    )
  })

  test("check 13: on-demand cookie-aware conversion of the dynamic /account page", async () => {
    const anonymous = await get(START_PORT, "/account.md")
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).toContain("session=none")

    const authed = await get(START_PORT, "/account.md", {
      cookie: "session=abc123",
    })
    expect(await authed.text()).toContain("session=abc123")

    const negotiated = await get(START_PORT, "/account", {
      accept: "text/markdown",
      cookie: "session=abc123",
    })
    const negotiatedBody = await negotiated.text()
    expect(negotiatedBody).toContain("session=abc123")
    expect(negotiatedBody).not.toContain("<article")
  })

  test("opted-in /gated.md renders live and privately per requester", async () => {
    const anonymous = await get(START_PORT, "/gated.md")
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).toContain("session=none")

    const authed = await get(START_PORT, "/gated.md", {
      cookie: "session=abc123",
    })
    expect(await authed.text()).toContain("session=abc123")
    // rendered from the caller's cookies — a shared cache must not keep it
    expect(authed.headers.get("cache-control")).toBe("private, no-store")
  })

  test("opted-in /admin/reports.md serves its declared content behind the guard", async () => {
    // the proxy matcher covers /admin/:path*, so the anonymous request is
    // turned away before anything of ours runs
    expect((await get(START_PORT, "/admin/reports.md")).status).toBe(307)
    const authed = await get(START_PORT, "/admin/reports.md", {
      cookie: "session=abc123",
    })
    const body = await authed.text()
    expect(body).toContain("MD_CONTENT_REPORTS")
    expect(body).not.toContain("SENTINEL_REPORTS")
  })

  test("proxy-guarded /admin.md stays gated on demand", async () => {
    expect((await get(START_PORT, "/admin.md")).status).toBe(404)
    const authed = await get(START_PORT, "/admin.md", {
      cookie: "session=abc123",
    })
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

  test("check 23: ctx.sections carry the grouping, and none is empty", () => {
    const body = read("llms.txt")
    const lines = body.split("\n")
    // the unheaded root block comes first, then a section per path segment
    expect(lines[1]).toBe("SECTION:")
    expect(body).toContain("SECTION:Docs")
    expect(body).toContain("SECTION:Admin")
    expect(body).toContain("SECTION:Tags")
    // every section handed to the function has at least one route under it
    for (const [i, line] of lines.entries()) {
      if (line.startsWith("SECTION:")) {
        expect(`${line} -> ${lines[i + 1]}`).toContain("-> ROUTE:")
      }
    }
  })

  test("check 23: hrefs are .md, index precedence applied", () => {
    const body = read("llms.txt")
    expect(body).toContain(
      "ROUTE:MD_TITLE_TOKENS|/docs/api/tokens.md|MD_DESC_TOKENS"
    )
    expect(body).toContain("ROUTE:MD_TITLE_PLAIN|/plain.md|MD_DESC_PLAIN")
    expect(body).toContain(
      "ROUTE:About Us | Fixture Site|/about.md|Who we are and why."
    )
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

describe("llmsfulltxt function build", () => {
  beforeAll(async () => {
    cleanFixture()
    await buildFixture({ LLMSFULLTXT_FN: "1" })
  })

  test("its return owns llms-full.txt and routes carry finalized content", () => {
    const body = readFileSync(join(PUBLIC, "llms-full.txt"), "utf8")
    expect(body).toStartWith("LLMSFULLTXT_FN:Fixture Site:A test site.")
    expect(body).toContain(
      "ROUTE:MD_TITLE_TOKENS|/docs/api/tokens.md|MD_DESC_TOKENS|MD_CONTENT_TOKENS"
    )
    expect(body).not.toContain("SENTINEL_TOKENS")
    expect(body).not.toContain("meta-description:")
  })

  test("its sections mirror llmstxt grouping and contain only publishable routes", () => {
    const body = readFileSync(join(PUBLIC, "llms-full.txt"), "utf8")
    expect(
      body.split("\n").filter((line) => line.startsWith("SECTION:"))
    ).toEqual([
      "SECTION:",
      "SECTION:Admin",
      "SECTION:Blog",
      "SECTION:Docs",
      "SECTION:Tags",
    ])
    expect(body).toContain("ROUTE:MD_TITLE_GATED|/gated.md|MD_DESC_GATED|")
    expect(body).toContain("[Requires session](/gated.md)")
    expect(body).not.toContain("/account.md")
    expect(body).not.toContain("/admin.md")
    expect(body).not.toContain("/docs/internal/")
  })
})

describe("existing llms surfaces", () => {
  const custom = "# Hand-authored llms.txt\n"
  const fullRoute = join(FIXTURE, "app", "llms-full.txt")
  const aboutRoute = join(FIXTURE, "app", "about.md")
  let server: Server

  beforeAll(async () => {
    cleanFixture()
    await buildFixture()
    expect(existsSync(join(PUBLIC, "about.md"))).toBe(true)
    mkdirSync(PUBLIC, { recursive: true })
    writeFileSync(join(PUBLIC, "llms.txt"), custom)
    for (const [dir, body] of [
      [fullRoute, "custom full text"],
      [aboutRoute, "custom about markdown"],
    ] as const) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "route.ts"),
        `export const GET = () => new Response(${JSON.stringify(body)})\n`
      )
    }
    await buildFixture({
      LLMSFULLTXT_FN: "track",
      LLMSTXT_FN: "throw",
    })
    server = await startServer(["start"], CUSTOM_START_PORT)
  })

  afterAll(async () => {
    await server.stop()
    rmSync(fullRoute, { force: true, recursive: true })
    rmSync(aboutRoute, { force: true, recursive: true })
    rmSync(join(PUBLIC, "llms.txt"), { force: true })
    await buildFixture({ LLMSFULLTXT_FN: "1" })
  })

  test("preserves the existing file without invoking its generator", () => {
    expect(readFileSync(join(PUBLIC, "llms.txt"), "utf8")).toBe(custom)
    expect(existsSync(join(FIXTURE, "llmstxt-invoked"))).toBe(false)
  })

  test("serves exact App Router routes without generating over them", async () => {
    expect(existsSync(join(PUBLIC, "llms-full.txt"))).toBe(false)
    expect(existsSync(join(PUBLIC, "about.md"))).toBe(false)
    expect(existsSync(join(FIXTURE, "llmsfulltxt-invoked"))).toBe(false)
    expect(await (await get(CUSTOM_START_PORT, "/llms-full.txt")).text()).toBe(
      "custom full text"
    )
    expect(await (await get(CUSTOM_START_PORT, "/about.md")).text()).toBe(
      "custom about markdown"
    )
  })
})

describe("existing per-page markdown", () => {
  const aboutRoute = join(FIXTURE, "app", "about.md")

  beforeAll(async () => {
    cleanFixture()
    mkdirSync(aboutRoute, { recursive: true })
    writeFileSync(
      join(aboutRoute, "route.ts"),
      'export const GET = () => new Response("custom about markdown")\n'
    )
    await buildFixture()
  })

  afterAll(async () => {
    rmSync(aboutRoute, { force: true, recursive: true })
    await buildFixture({ LLMSFULLTXT_FN: "1" })
  })

  test("indexes the existing route without generating competing content", () => {
    expect(existsSync(join(PUBLIC, "about.md"))).toBe(false)
    expect(readFileSync(join(PUBLIC, "llms.txt"), "utf8")).toContain(
      "](/about.md)"
    )
    const full = readFileSync(join(PUBLIC, "llms-full.txt"), "utf8")
    expect(full).toContain("[Read markdown](/about.md)")
    expect(full).not.toContain("MD_OVERRIDE_ABOUT")
    expect(full).not.toContain("SENTINEL_ABOUT")
  })
})

// ---------------------------------------------------------------------------
// Local builds — no deploy env (CI/VERCEL unset): the static tier is skipped,
// leftovers from earlier deploy builds are pruned, and next start serves every
// surface through the on-demand route instead.
// ---------------------------------------------------------------------------

describe("local build — no deploy env", () => {
  let server: Server

  beforeAll(async () => {
    // the llmstxt describe just left deploy-built files in public/ — this
    // build must remove them and add nothing new
    mkdirSync(join(PUBLIC, "docs", "api"), { recursive: true })
    writeFileSync(join(PUBLIC, HAND_EDITED), HAND_EDIT)
    await buildFixture({ CI: "", VERCEL: "" })
    server = await startServer(["start"], LOCAL_START_PORT)
  })

  afterAll(async () => {
    await server.stop()
  })

  test("public/ carries no generated files after a local build", () => {
    for (const rel of [...GENERATED, ...NEVER_GENERATED]) {
      if (rel === HAND_EDITED) {
        continue
      }
      expect(existsSync(join(PUBLIC, rel))).toBe(false)
    }
  })

  test("a hand-edited generated file is never pruned", () => {
    expect(readFileSync(join(PUBLIC, HAND_EDITED), "utf8")).toBe(HAND_EDIT)
  })

  test("directories emptied by pruning go too, but ones still holding files stay", () => {
    expect(existsSync(join(PUBLIC, "tags"))).toBe(false)
    expect(existsSync(join(PUBLIC, "blog"))).toBe(false)
    // docs/api still holds the hand-edited file
    expect(existsSync(join(PUBLIC, "docs", "api"))).toBe(true)
  })

  test("llms.txt serves on demand from the built route list", async () => {
    const res = await get(LOCAL_START_PORT, "/llms.txt")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("# Fixture Site")
    expect(body).toContain("> A test site.")
    // dynamic instances from generateStaticParams are in the built output
    expect(body).toContain("](/blog/hello.md)")
    expect(body).toContain("](/tags/alpha.md)")
    expect(body).toContain("## Docs")
    // index-entry precedence still applies on demand
    expect(body).toContain(
      "- [MD_TITLE_TOKENS](/docs/api/tokens.md): MD_DESC_TOKENS"
    )
    // exclusions hold: shared exclude, proxy matcher, dynamic pages
    expect(body).not.toContain("/docs/internal/")
    expect(body).not.toContain("/admin.md")
    expect(body).not.toContain("/account.md")
    expect(body).not.toContain("/echo.md")
  })

  test("the on-demand index agrees with the static tier on gated opt-ins", async () => {
    const body = await (await get(LOCAL_START_PORT, "/llms.txt")).text()
    expect(body).toContain("- [MD_TITLE_GATED](/gated.md): MD_DESC_GATED")
    expect(body).toContain(
      "- [MD_TITLE_REPORTS](/admin/reports.md): MD_DESC_REPORTS"
    )
    // opting one /admin route in does not drag the rest of the guard with it
    expect(body).not.toContain("(/admin.md)")
  })

  test("llms-full.txt serves on demand", async () => {
    const res = await get(LOCAL_START_PORT, "/llms-full.txt")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toStartWith("# Fixture Site")
    for (const present of [
      "SENTINEL_HOME",
      "MD_OVERRIDE_ABOUT",
      "MD_TAG_alpha",
      "SENTINEL_GETTING_STARTED",
    ]) {
      expect(body).toContain(present)
    }
    expect(body).not.toContain("SENTINEL_ADMIN")
    expect(body).not.toContain("SENTINEL_ACCOUNT")
    expect(body).not.toContain("SENTINEL_SECRETS")
    // gated opt-ins publish exactly what they declared, here as everywhere
    expect(body).toContain(
      "# MD_TITLE_GATED\n\n> MD_DESC_GATED\n\n[Requires session](/gated.md)"
    )
    expect(body).toContain("MD_CONTENT_REPORTS")
    expect(body).not.toContain("SENTINEL_GATED")
    expect(body).not.toContain("SENTINEL_REPORTS")
  })

  test(".md twins and Accept negotiation serve on demand", async () => {
    expect(await (await get(LOCAL_START_PORT, "/about.md")).text()).toContain(
      "MD_OVERRIDE_ABOUT"
    )
    expect(await (await get(LOCAL_START_PORT, "/zebra.md")).text()).toContain(
      "SENTINEL_ZEBRA"
    )
    expect((await get(LOCAL_START_PORT, "/nonexistent.md")).status).toBe(404)
    const negotiated = await get(LOCAL_START_PORT, "/docs/getting-started", {
      accept: "text/markdown",
    })
    expect(await negotiated.text()).toContain("SENTINEL_GETTING_STARTED")
  })
})

// ---------------------------------------------------------------------------
// Deploy bundle: a serverless platform runs the on-demand route from the
// build's file traces, not the project's node_modules. Standalone output is
// assembled from those same traces, so serving it from outside the repo (where
// Node can't walk up into the real node_modules) catches anything the trace
// leaves out — as the converter's platform binding once was, turning every
// on-demand request into an empty 500.
// ---------------------------------------------------------------------------

describe("deploy bundle — standalone output", () => {
  let server: Server

  beforeAll(async () => {
    await buildFixture({ STANDALONE: "1" })
    const bundle = mkdtempSync(join(tmpdir(), "next-with-text-bundle-"))
    cpSync(join(FIXTURE, ".next", "standalone"), bundle, {
      recursive: true,
      verbatimSymlinks: true,
    })
    const app = join(bundle, relative(ROOT, FIXTURE))
    cpSync(PUBLIC, join(app, "public"), { recursive: true })
    server = await launch(["node", "server.js"], app, BUNDLE_PORT)
  })

  afterAll(async () => {
    await server.stop()
  })

  test("excluded and unknown .md routes 404", async () => {
    const excluded = await get(BUNDLE_PORT, "/docs/internal/secrets.md")
    expect(excluded.status).toBe(404)
    expect((await get(BUNDLE_PORT, "/nonexistent.md")).status).toBe(404)
  })

  test("pages outside the static tier convert on demand", async () => {
    // /blog/fresh is not in generateStaticParams, so no static twin exists
    const res = await get(BUNDLE_PORT, "/blog/fresh.md")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("SENTINEL_BLOG_FRESH")
    expect(server.logs()).not.toContain("native binding")
  })
})
