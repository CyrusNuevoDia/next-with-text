import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Getting Started",
  description: "How to get started with the fixture.",
}

export default function GettingStarted() {
  return (
    <article>
      <h1>Getting Started</h1>
      <p>SENTINEL_GETTING_STARTED: install and run.</p>
      <img src="/images/team.png" alt="The team" />
      <h2>Install</h2>
      <p>
        Run <code>bun install</code> first.
      </p>
    </article>
  )
}
