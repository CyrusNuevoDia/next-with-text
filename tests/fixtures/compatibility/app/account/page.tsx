import { cookies } from "next/headers"

export default async function Account() {
  const session = (await cookies()).get("session")?.value ?? "none"
  return <p>COMPAT_ACCOUNT session={session}</p>
}
