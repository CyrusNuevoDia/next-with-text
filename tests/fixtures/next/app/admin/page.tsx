export const metadata = {
  description: "Edge-protected static page.",
  title: "Admin",
}

export default function Admin() {
  return (
    <article>
      <h1>Admin</h1>
      <p>SENTINEL_ADMIN: static but proxy-guarded.</p>
    </article>
  )
}
