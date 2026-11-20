import { createHash } from "node:crypto"
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

export const BUNDLERS = ["webpack", "turbopack"] as const
export const MODES = ["plain", "adapter"] as const
const STABLE_PATCH = /^16\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SHA = /^[a-f0-9]{40}$/
const SHA512 = /^[a-f0-9]{128}$/
const NEXT_SECURITY_STOP =
  /(?:^|\n)Error \[SecurityFatalError\]: Your version of Next\.js is affected by a known security vulnerability\./
const REVIEWED_SECURITY_STOPS = new Set([
  "16.4.0",
  "16.4.1",
  "16.4.2",
  "16.4.3",
  "16.4.4",
])
export const SECURITY_ADVISORY =
  "https://github.com/vercel/next.js/releases/tag/v16.4.5"

// Preserve the published historical roster even if the registry response is truncated.
const HISTORICAL = [11, 7, 12, 8, 6].flatMap((last, minor) =>
  Array.from({ length: last + 1 }, (_, patch) => `16.${minor}.${patch}`)
)
const CHECKPOINTS = ["16.0.0", "16.1.0", "16.2.0", "16.3.0", "16.3.7", "16.3.8"]

type Plan = { digest: string; sha: string; versions: string[] }

type Case = {
  version: string
  bundler: (typeof BUNDLERS)[number]
  mode: (typeof MODES)[number]
}

export type Receipt = Case & {
  digest: string
  sha: string
} & (
    | { status: "pass" }
    | { status: "upstream-blocked"; control: "next-security-stop" }
  )

export function digestOf(path: string): string {
  return createHash("sha512").update(readFileSync(path)).digest("hex")
}

export function nextVersions(input: unknown, baseline = HISTORICAL): string[] {
  const candidates = typeof input === "string" ? [input] : input
  if (
    !Array.isArray(candidates) ||
    candidates.some((value) => typeof value !== "string")
  ) {
    throw new Error("Invalid Next registry inventory")
  }
  const versions = candidates.filter((value: string) =>
    STABLE_PATCH.test(value)
  ) as string[]
  if (versions.length === 0) {
    throw new Error("No stable Next 16 versions in registry inventory")
  }
  const unique = new Set(versions)
  if (unique.size !== versions.length) {
    throw new Error("Duplicate Next version in registry inventory")
  }
  for (const required of baseline) {
    if (!unique.has(required)) {
      throw new Error(`Missing historical Next version ${required}`)
    }
  }
  return versions.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
}

export function isReviewedSecurityStop(version: string, logs: string): boolean {
  return REVIEWED_SECURITY_STOPS.has(version) && NEXT_SECURITY_STOP.test(logs)
}

function caseKey(version: unknown, bundler: unknown, mode: unknown): string {
  return `${version}/${bundler}/${mode}`
}

export function checkCoverage(
  plan: Plan,
  receipts: unknown[]
): { blocked: number; passed: number } {
  if (!(SHA.test(plan.sha) && SHA512.test(plan.digest))) {
    throw new Error("Invalid candidate commit or artifact digest")
  }
  const expected = new Set(
    nextVersions(plan.versions, []).flatMap((version) =>
      BUNDLERS.flatMap((bundler) =>
        MODES.map((mode) => caseKey(version, bundler, mode))
      )
    )
  )
  const seen = new Set<string>()
  let passed = 0
  let blocked = 0
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error("Invalid compatibility receipt")
    }
    const row = receipt as Record<string, unknown>
    const key = caseKey(row.version, row.bundler, row.mode)
    if (!expected.has(key)) {
      throw new Error(`Unexpected compatibility case ${key}`)
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate compatibility case ${key}`)
    }
    if (row.sha !== plan.sha || row.digest !== plan.digest) {
      throw new Error(`Wrong commit or artifact for ${key}`)
    }
    if (row.status === "pass") {
      passed += 1
    } else if (
      row.status === "upstream-blocked" &&
      row.control === "next-security-stop" &&
      typeof row.version === "string" &&
      REVIEWED_SECURITY_STOPS.has(row.version)
    ) {
      blocked += 1
    } else {
      throw new Error(`Unverified compatibility case ${key}`)
    }
    seen.add(key)
  }
  const missing = [...expected].filter((key) => !seen.has(key))
  if (missing.length) {
    throw new Error(`Missing compatibility cases: ${missing.join(", ")}`)
  }
  return { blocked, passed }
}

if (import.meta.main) {
  const [command, first, second, third] = process.argv.slice(2)
  if (command === "plan" && first && second && third) {
    const all = nextVersions(JSON.parse(readFileSync(first, "utf8")))
    const versions =
      process.env.COMPAT_SCOPE === "checkpoints"
        ? [...new Set([...CHECKPOINTS, all.at(-1) as string])]
        : all
    const plan = {
      digest: digestOf(second),
      sha: third,
      versions,
    } satisfies Plan
    writeFileSync("plan.json", JSON.stringify(plan))
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `versions=${JSON.stringify(versions)}\n`
      )
    }
  } else if (command === "verify" && first && second) {
    const plan = JSON.parse(readFileSync(first, "utf8")) as Plan
    const receipts = readdirSync(second, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8"))
      )
    const { passed, blocked } = checkCoverage(plan, receipts)
    const summary = `Next 16 compatibility: ${passed} passed, ${blocked} upstream-blocked, ${receipts.length} observed.\n\nCommit \`${plan.sha}\`\n\nTarball SHA-512 \`${plan.digest}\`\n`
    console.log(summary)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
    }
  } else {
    throw new Error(
      "Expected plan <inventory> <tarball> <commit> or verify <plan> <receipts-dir>"
    )
  }
}
