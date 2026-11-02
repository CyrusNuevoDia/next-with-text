// Opt in after `bun run build`:
// NEXT_COMPAT_VERSION=16.0.0 NEXT_COMPAT_BUNDLER=webpack bun test tests/compatibility.test.ts
// CI covers 16.0.0, 16.1.0, 16.2.0, 16.3.7, 16.3.8, 16.4.4 with both bundlers.
// NEXT_WITH_TEXT_TARBALL may select the exact artifact already tested for packaging.
import { expect, test } from "bun:test"
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { sleep, spawn } from "bun"

const ROOT = join(import.meta.dir, "..")
const VERSION = process.env.NEXT_COMPAT_VERSION
const BUNDLER = process.env.NEXT_COMPAT_BUNDLER
const ENABLED = VERSION !== undefined || BUNDLER !== undefined
const DIST_DIR = ".compat-next"
const EXACT_NEXT_VERSION = /^16\.\d+\.\d+$/

type Command = {
  exited: Promise<number>
  logs: () => string
  stop: () => Promise<void>
}

function command(args: string[], cwd: string, timeout: number): Command {
  const proc = spawn(args, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      CI: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  let output = ""
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      output = (output + decoder.decode(chunk, { stream: true })).slice(
        -500_000
      )
    }
  }
  const kill = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      if (process.platform === "win32") {
        proc.kill(signal)
      } else {
        process.kill(-proc.pid, signal)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error
      }
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    kill("SIGKILL")
  }, timeout)
  const exited = Promise.all([
    proc.exited,
    capture(proc.stdout),
    capture(proc.stderr),
  ]).then(([code]) => {
    clearTimeout(timer)
    return code
  })
  return {
    exited,
    logs: () =>
      `${args.join(" ")} (cwd: ${cwd})${timedOut ? " TIMED OUT" : ""}\n${output}`,
    stop: async () => {
      clearTimeout(timer)
      kill("SIGTERM")
      await Promise.race([exited, sleep(5000)])
      kill("SIGKILL")
      await exited
    },
  }
}

async function run(args: string[], cwd: string, timeout = 30_000) {
  const proc = command(args, cwd, timeout)
  try {
    if ((await proc.exited) !== 0) {
      throw new Error(proc.logs())
    }
    return proc.logs()
  } finally {
    await proc.stop()
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolvePort)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Cannot allocate a compatibility server port")
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
  return address.port
}

async function ready(server: Command, URL: string) {
  let exited = false
  server.exited.then(() => {
    exited = true
  })
  const deadline = Date.now() + 60_000
  while (!exited && Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: readiness polling is sequential
      const res = await fetch(URL, { signal: AbortSignal.timeout(2000) })
      if (res.ok && (await res.text()).includes("COMPAT_PUBLIC_HOME")) {
        return
      }
    } catch {
      // A newly spawned server hasn't bound its port yet.
    }
    await sleep(200)
  }
  throw new Error(
    `Compatibility server did not become ready:\n${server.logs()}`
  )
}

test.skipIf(!ENABLED)(
  `packed Next ${VERSION} / ${BUNDLER}: custom distDir and public/private surfaces`,
  async () => {
    if (!(VERSION && EXACT_NEXT_VERSION.test(VERSION))) {
      throw new Error("NEXT_COMPAT_VERSION must be an exact Next 16 version")
    }
    if (BUNDLER !== "webpack" && BUNDLER !== "turbopack") {
      throw new Error("NEXT_COMPAT_BUNDLER must be webpack or turbopack")
    }

    const temp = mkdtempSync(join(tmpdir(), "next-with-text-compat-"))
    const consumer = join(temp, "consumer")
    let server: Command | undefined
    try {
      cpSync(join(ROOT, "tests", "fixtures", "compatibility"), consumer, {
        recursive: true,
      })
      let tarball = process.env.NEXT_WITH_TEXT_TARBALL
      if (tarball) {
        tarball = resolve(tarball)
      } else {
        tarball = join(temp, "next-with-text.tgz")
        await run(
          ["bun", "pm", "pack", "--ignore-scripts", "--filename", tarball],
          ROOT
        )
      }
      if (!existsSync(tarball)) {
        throw new Error(`Packed package does not exist: ${tarball}`)
      }
      const manifestPath = join(consumer, "package.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      manifest.dependencies.next = VERSION
      manifest.dependencies["next-with-text"] = tarball
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
      await run(
        ["bun", "install", "--ignore-scripts", "--linker", "hoisted"],
        consumer,
        180_000
      )
      const installed = join(consumer, "node_modules")
      expect(
        lstatSync(join(installed, "next-with-text")).isSymbolicLink()
      ).toBe(false)
      expect(
        JSON.parse(
          readFileSync(join(installed, "next", "package.json"), "utf8")
        ).version
      ).toBe(VERSION)

      // A real consumer checks our emitted declarations against the selected
      // Next version, without skipLibCheck hiding a newer Next-only import.
      await run(["bun", "check-types.cjs"], consumer, 60_000)
      const next = join(installed, ".bin", "next")
      expect(await run([next, "build", "--help"], consumer)).toContain(
        `--${BUNDLER}`
      )
      await run([next, "build", `--${BUNDLER}`], consumer, 240_000)
      expect(existsSync(join(consumer, DIST_DIR, "BUILD_ID"))).toBe(true)
      expect(existsSync(join(consumer, ".next"))).toBe(false)

      const publicDir = join(consumer, "public")
      const markdown = (file: string) =>
        readFileSync(join(publicDir, file), "utf8")
      expect(markdown("index.md")).toContain("COMPAT_PUBLIC_HOME")
      expect(markdown("notes/alpha.md")).toContain("COMPAT_MD_NOTE_alpha")
      expect(markdown("llms.txt")).toContain("](/notes/alpha.md)")
      const full = markdown("llms-full.txt")
      expect(full).toContain("COMPAT_PUBLIC_HOME")
      expect(full).toContain("COMPAT_MD_NOTE_alpha")
      for (const route of ["account", "protected", "hidden"]) {
        expect(existsSync(join(publicDir, `${route}.md`))).toBe(false)
        expect(markdown("llms.txt")).not.toContain(`/${route}.md`)
      }
      for (const privateContent of [
        "COMPAT_ACCOUNT",
        "COMPAT_PROTECTED_SECRET",
        "COMPAT_EXCLUDED_SECRET",
      ]) {
        expect(full).not.toContain(privateContent)
      }

      const port = await freePort()
      const origin = `http://127.0.0.1:${port}`
      const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(`${origin}${path}`, {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        })
      server = command(
        [next, "start", "--hostname", "127.0.0.1", "--port", String(port)],
        consumer,
        120_000
      )
      await ready(server, origin)
      const negotiated = await get("/notes/alpha", { accept: "text/markdown" })
      expect(negotiated.status).toBe(200)
      expect(negotiated.headers.get("content-type")).toContain("text/markdown")
      expect(await negotiated.text()).toContain("COMPAT_MD_NOTE_alpha")
      const browser = await get("/notes/alpha", {
        accept: "text/html,text/markdown;q=0.9",
      })
      expect(browser.headers.get("content-type")).toContain("text/html")
      expect(await browser.text()).toContain("COMPAT_NOTE_alpha")
      expect((await get("/hidden.md")).status).toBe(404)
      expect((await get("/protected.md")).status).toBe(404)
      const protectedPage = await get("/protected.md", {
        cookie: "session=allowed",
      })
      expect(protectedPage.status).toBe(200)
      expect(await protectedPage.text()).toContain("COMPAT_PROTECTED_SECRET")
      for (const session of ["first", "second"]) {
        // biome-ignore lint/performance/noAwaitInLoops: a later session must not reuse the earlier response
        const account = await get("/account.md", {
          cookie: `session=${session}`,
        })
        expect(account.status).toBe(200)
        expect(account.headers.get("cache-control")).toBe("private, no-store")
        expect(await account.text()).toContain(
          `COMPAT_ACCOUNT session=${session}`
        )
      }
      expect(await (await get("/account.md")).text()).toContain(
        "COMPAT_ACCOUNT session=none"
      )
      if (VERSION === "16.0.0" && BUNDLER === "webpack") {
        await server.stop()
        server = undefined
        appendFileSync(
          join(consumer, "app", "page.tsx"),
          "\nexport const unsupportedPageExport = true\n"
        )
        const invalid = command([next, "build", "--webpack"], consumer, 240_000)
        try {
          expect(await invalid.exited).not.toBe(0)
          expect(invalid.logs()).toContain("unsupportedPageExport")
          expect(invalid.logs()).toContain("not a valid Page export")
        } finally {
          await invalid.stop()
        }
      }
    } catch (error) {
      throw new Error(
        // biome-ignore lint/suspicious/noUnnecessaryConditions: installation can fail before the server is assigned
        `Next ${VERSION} / ${BUNDLER} compatibility failed\n${server?.logs() ?? ""}`,
        { cause: error }
      )
    } finally {
      await server?.stop()
      rmSync(temp, { force: true, recursive: true })
    }
  },
  900_000
)
