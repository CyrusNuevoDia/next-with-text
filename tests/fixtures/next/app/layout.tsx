import type { Metadata } from "next"

export const metadata: Metadata = {
  title: { default: "Fixture Site", template: "%s | Fixture Site" },
  description: "A test site.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <a href="/">Home</a> <a href="/about">About</a>
        </nav>
        <main>{children}</main>
        <footer>Footer boilerplate that should not appear in markdown.</footer>
      </body>
    </html>
  )
}
