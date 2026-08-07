import { cookies } from "next/headers"

export const metadata = {
  description: "Private account page.",
  title: "Account",
}

export default async function Account() {
  const jar = await cookies()
  return (
    <article>
      <h1>Account</h1>
      <p>
        SENTINEL_ACCOUNT: private, session={jar.get("session")?.value ?? "none"}
        .
      </p>
    </article>
  )
}
