---
"next-with-text": patch
---

Fix Markdown generation for nested index routes, preserve `md` overrides when an adapter uses `basePath`, and resolve Next.js from the app when running `next build` from a parent directory. Support native ESM and CommonJS imports on Node.js 20.9 and newer.

Verify the release tarball against every stable Next.js 16 patch in parallel, using webpack and Turbopack with and without a deployment adapter.
