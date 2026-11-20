import { expect, test } from "bun:test"
import { checkCoverage, nextVersions } from "./compatibility-report.js"

const sha = "a".repeat(40)
const digest = "b".repeat(128)
const plan = { digest, sha, versions: ["16.4.4"] }
const rows = [
  { bundler: "webpack", mode: "plain" },
  { bundler: "webpack", mode: "adapter" },
  { bundler: "turbopack", mode: "plain" },
  { bundler: "turbopack", mode: "adapter" },
].map((row) => ({ ...row, digest, sha, status: "pass", version: "16.4.4" }))

test("a compatibility gate requires each exact case once for the published bytes", () => {
  expect(checkCoverage(plan, rows)).toEqual({ blocked: 0, passed: 4 })
  expect(() => checkCoverage(plan, rows.slice(1))).toThrow("Missing")
  expect(() => checkCoverage(plan, [...rows, rows[0]])).toThrow("Duplicate")
  expect(() =>
    checkCoverage(plan, [
      { ...rows[0], digest: "c".repeat(128) },
      ...rows.slice(1),
    ])
  ).toThrow("artifact")
  expect(() =>
    checkCoverage(plan, [{ ...rows[0], status: "skip" }, ...rows.slice(1)])
  ).toThrow("Unverified")
})

test("a reviewed Next security stop needs the same stop from plain Next", () => {
  const stop = { ...rows[0], status: "upstream-blocked" }
  expect(() => checkCoverage(plan, [stop, ...rows.slice(1)])).toThrow(
    "Unverified"
  )
  expect(
    checkCoverage(plan, [
      { ...stop, control: "next-security-stop" },
      ...rows.slice(1),
    ])
  ).toEqual({ blocked: 1, passed: 3 })
})

test("exact inventory includes backports and sorts patches numerically", () => {
  const registry = ["16.2.10", "16.2.9", "16.4.6", "16.4.7-canary.0", "17.0.0"]
  expect(nextVersions(registry, ["16.2.9", "16.4.6"])).toEqual([
    "16.2.9",
    "16.2.10",
    "16.4.6",
  ])
  expect(() => nextVersions(registry, ["16.0.0"])).toThrow("Missing")
  expect(() => nextVersions([], [])).toThrow("No stable")
})
