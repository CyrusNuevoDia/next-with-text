import { cookies } from "next/headers"

export const metadata = { title: "Account", description: "Private account page." }

export default async function Account() {
  const jar = await cookies()
  return (
    <article>
      <h1>Account</h1>
      <p>SENTINEL_ACCOUNT: private, session={jar.get("session")?.value ?? "none"}.</p>
    </article>
  )
}
