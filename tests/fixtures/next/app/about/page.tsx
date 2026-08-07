import type { Metadata } from "next"
import type { MarkdownPage } from "next-with-text"

export const metadata: Metadata = {
  title: "About Us",
  description: "Who we are and why.",
}

export default function About() {
  return (
    <article>
      <h1>About Us</h1>
      <p>SENTINEL_ABOUT: we make fixtures.</p>
      <img src="/images/team.png" alt="The team" />
      <ul>
        <li>First value</li>
        <li>Second value</li>
      </ul>
      <pre>
        <code>{`const x = 42`}</code>
      </pre>
      <a href="/docs/getting-started">Read the docs</a>
    </article>
  )
}

export const md: MarkdownPage = async () => "MD_OVERRIDE_ABOUT: custom markdown content."
