---
"next-with-text": patch
---

Read an adapter build's prerendered HTML from the adapter API's build outputs instead of walking `.next/server/app`. Next 16.3.8 writes those prerenders under `.next/server/route-cache` whenever an adapter is configured (which Vercel's builder does), so deploys there shipped an `llms.txt` with an empty title and no pages and an empty `llms-full.txt`. A build that discovers no pages now warns in the build log instead of publishing empty indexes silently.
