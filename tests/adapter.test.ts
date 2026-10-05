// The adapter API's build outputs are the one layout-independent account of
// what a build prerendered and where: this pins which outputs count as pages.
import { describe, expect, test } from "bun:test"
import { adapterPrerenders } from "../src/shared.js"

type Outputs = Parameters<typeof adapterPrerenders>[0]

function outputs(
  prerenders: Record<string, unknown>[],
  appPageIds: string[]
): Outputs {
  return {
    appPages: appPageIds.map((id) => ({ id })),
    prerenders,
  } as unknown as Outputs
}

const html = (route: string) =>
  `/site/.next/server/route-cache/APP_PAGE/abc/$${route === "/" ? "/index" : route}.html`

describe("adapterPrerenders", () => {
  test("maps each complete app page to its prerendered HTML", () => {
    const result = adapterPrerenders(
      outputs(
        [
          {
            fallback: { filePath: html("/") },
            parentOutputId: "/",
            pathname: "/",
            routeType: "page",
          },
          {
            fallback: { filePath: "/site/.next/server/app/index.rsc" },
            parentOutputId: "/",
            pathname: "/index.rsc",
          },
          {
            fallback: { filePath: html("/tags/alpha") },
            parentOutputId: "/tags/[tag]",
            pathname: "/tags/alpha",
            routeType: "page",
          },
        ],
        ["/", "/tags/[tag]"]
      ),
      ""
    )
    expect(result).toEqual({
      "/": html("/"),
      "/tags/alpha": html("/tags/alpha"),
    })
  })

  test("skips fallback shells, private routes, and pages-router prerenders", () => {
    const result = adapterPrerenders(
      outputs(
        [
          {
            fallback: { filePath: html("/blog/[slug]") },
            parentOutputId: "/blog/[slug]",
            pathname: "/blog/[slug]",
            routeType: "fallback",
          },
          {
            fallback: { filePath: html("/_not-found") },
            parentOutputId: "/_not-found",
            pathname: "/_not-found",
            routeType: "page",
          },
          {
            fallback: { filePath: "/site/.next/server/pages/legacy.html" },
            parentOutputId: "/legacy",
            pathname: "/legacy",
            routeType: "page",
          },
          {
            fallback: { filePath: html("/about") },
            parentOutputId: "/about",
            pathname: "/about",
            routeType: "page",
          },
        ],
        ["/blog/[slug]", "/_not-found", "/about"]
      ),
      ""
    )
    expect(result).toEqual({ "/about": html("/about") })
  })

  test("strips the basePath the adapter prefixes onto every pathname", () => {
    const result = adapterPrerenders(
      outputs(
        [
          {
            fallback: { filePath: html("/") },
            parentOutputId: "/",
            pathname: "/docs",
            routeType: "page",
          },
          {
            fallback: { filePath: html("/about") },
            parentOutputId: "/about",
            pathname: "/docs/about",
            routeType: "page",
          },
        ],
        ["/", "/about"]
      ),
      "/docs"
    )
    expect(result).toEqual({ "/": html("/"), "/about": html("/about") })
  })
})
