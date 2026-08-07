import type { Metadata } from "next"

export const metadata: Metadata = {
  description: "Authenticating against the API.",
  title: "API Auth",
}

export default function APIAuth() {
  return (
    <article>
      <h1>API Auth</h1>
      <p>SENTINEL_API_AUTH: send the bearer token.</p>
    </article>
  )
}
