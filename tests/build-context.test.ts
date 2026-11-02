import { describe, expect, test } from "bun:test"
import {
  adapterField,
  buildContext,
  registerAdapter,
} from "../src/build-context.js"

const projectDir = "/repo/apps/site"
const distDir = "/repo/apps/site/build-output"

function context(middleware?: unknown) {
  return {
    config: { basePath: "", outputFileTracingRoot: "/repo" },
    distDir,
    outputs: { appPages: [], middleware, prerenders: [] },
    projectDir,
  }
}

describe("adapter build context", () => {
  test("uses supplied artifacts and canonical page modules across storage layouts", () => {
    const input = context()
    const module =
      "/repo/apps/site/build-output/server/app/(docs)/guide/page.js"
    const html =
      "/repo/apps/site/build-output/server/route-cache/opaque-key.html"
    const output = buildContext({
      ...input,
      config: { ...input.config, output: "standalone" },
      outputs: {
        ...input.outputs,
        appPages: [
          {
            filePath: module,
            id: "/guide.rsc",
            pathname: "/guide.rsc",
            sourcePage: "/(docs)/guide/page",
          },
          {
            filePath: module,
            id: "/guide",
            pathname: "/guide",
            sourcePage: "/(docs)/guide/page",
          },
        ],
        prerenders: [
          {
            fallback: { filePath: html },
            parentOutputId: "/guide",
            pathname: "/guide",
          },
        ],
      },
    })
    expect(output.pages).toEqual([{ filePath: module, pattern: "/guide" }])
    expect(output.prerenderedHTML).toEqual({ "/guide": html })
    expect(output.distDir).toBe(distDir)
    expect(output.standaloneDir).toBe(`${distDir}/standalone/apps/site`)
  })

  test("retains plain guards after removing Next's prerender bypass", () => {
    const output = buildContext(
      context({
        config: {
          matchers: [
            {
              missing: [
                {
                  key: "x-prerender-revalidate",
                  type: "header",
                  value: "preview-token",
                },
              ],
              sourceRegex: "^/admin(?:/.*)?$",
            },
            {
              has: [{ key: "accept", type: "header", value: "text/markdown" }],
              sourceRegex: "^/.*$",
            },
            {
              missing: [{ key: "session", type: "cookie" }],
              sourceRegex: "^/conditional$",
            },
          ],
        },
      })
    )
    expect(output.proxyMatchers).toHaveLength(1)
    const [source] = output.proxyMatchers
    const guard = new RegExp(source ?? "^$")
    expect(guard.test("/admin/reports")).toBe(true)
    expect(guard.test("/public")).toBe(false)
    expect(buildContext(context()).proxyMatchers).toEqual([])
  })

  test.each([
    { config: {} },
    { config: { matchers: "invalid" } },
    { config: { matchers: [{ sourceRegex: "[" }] } },
    { config: { matchers: [{ has: ["invalid"], sourceRegex: "^/admin$" }] } },
    {
      config: {
        matchers: [{ missing: [{ key: "x" }], sourceRegex: "^/admin$" }],
      },
    },
  ])(
    "rejects malformed auth guards instead of treating them as public",
    (middleware) => {
      expect(() => buildContext(context(middleware))).toThrow()
    }
  )
})

describe("Next 16 adapter registration", () => {
  test.each([
    ["16.0.0", "experimental"],
    ["16.1.9", "experimental"],
    ["16.2.0", "stable"],
    ["16.3.8", "stable"],
  ] as const)("registers the adapter for Next %s", (version, field) => {
    const config = registerAdapter(
      { reactStrictMode: true },
      "/package/adapter.cjs",
      adapterField(version)
    )
    if (field === "experimental") {
      expect(config.experimental).toEqual({
        adapterPath: "/package/adapter.cjs",
      })
      expect(config.adapterPath).toBeUndefined()
    } else {
      expect(config.adapterPath).toBe("/package/adapter.cjs")
      expect(config.experimental).toEqual({})
    }
    expect(config.reactStrictMode).toBe(true)
  })
})
