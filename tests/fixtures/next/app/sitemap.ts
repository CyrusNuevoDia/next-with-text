import type { MetadataRoute } from "next"

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://fixture.example.com"
  return [
    "/",
    "/about",
    "/docs/getting-started",
    "/docs/api/auth",
    "/docs/internal/secrets",
    "/blog/hello",
    "/zebra",
  ].map((path) => ({ url: `${base}${path}` }))
}
