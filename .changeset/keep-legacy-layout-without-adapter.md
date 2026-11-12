---
"next-with-text": patch
---

Stop registering a build adapter when your config has none. Any `adapterPath` makes Next.js 16.3+ store prerendered pages under `.next/server/route-cache`, and Vercel's builder (unless `NEXT_ENABLE_ADAPTER=1`) still reads `.next/server/app/<route>.rsc`, so `vercel build` failed with `ENOENT … server/app/<route>.rsc` after upgrading to 0.4.1. Without an upstream adapter, next-with-text now leaves Next's output layout alone and generates after `next build` exits from Next's build manifests; with one, it still composes with that adapter as before.
