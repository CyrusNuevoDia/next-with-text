import type { ReactNode } from "react"

export const metadata = {
  description: "A packed package compatibility consumer.",
  title: "Compatibility Site",
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
