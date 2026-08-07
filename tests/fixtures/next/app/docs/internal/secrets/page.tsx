import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Internal Secrets",
  description: "Excluded page.",
}

export default function Secrets() {
  return (
    <article>
      <h1>Internal Secrets</h1>
      <p>SENTINEL_SECRETS: this must never appear in llms output.</p>
    </article>
  )
}
