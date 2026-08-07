import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  description: "Who we are and why.",
  title: "About Us",
}

export default function About() {
  return (
    <article>
      <h1>About Us</h1>
      <p>SENTINEL_ABOUT: we make fixtures.</p>
      <img alt="The team" height={360} src="/images/team.png" width={640} />
      <ul>
        <li>First value</li>
        <li>Second value</li>
      </ul>
      <pre>
        <code>{"const x = 42"}</code>
      </pre>
      <a href="/docs/getting-started">Read the docs</a>
    </article>
  )
}

export const md: MarkdownPage = async () =>
  "MD_OVERRIDE_ABOUT: custom markdown content."
