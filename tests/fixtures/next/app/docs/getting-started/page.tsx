import type { Metadata } from "next"

export const metadata: Metadata = {
  description: "How to get started with the fixture.",
  title: "Getting Started",
}

export default function GettingStarted() {
  return (
    <article>
      <h1>Getting Started</h1>
      <p>SENTINEL_GETTING_STARTED: install and run.</p>
      <img alt="The team" height={360} src="/images/team.png" width={640} />
      <h2>Install</h2>
      <p>
        Run <code>bun install</code> first.
      </p>
    </article>
  )
}
