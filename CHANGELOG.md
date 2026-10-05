# next-with-text

## 0.4.0

### Minor Changes

- 0588108: Export `convertHTMLtoMarkdown(html)` from the package entry: it turns an HTML string into the same markdown next-with-text writes for a page's `.md` twin (inline SVGs, data-URL images and the footer dropped; frontmatter limited to `title` and `meta-description`). `ConverterUnavailableError` and the `ConversionResult` type are exported alongside it. The function loads the converter's native addon on first call, so it is Node.js-only.

## 0.3.4

### Patch Changes

- b02896e: Read an adapter build's prerendered HTML from the adapter API's build outputs instead of walking `.next/server/app`. Next 16.3.8 writes those prerenders under `.next/server/route-cache` whenever an adapter is configured (which Vercel's builder does), so deploys there shipped an `llms.txt` with an empty title and no pages and an empty `llms-full.txt`. A build that discovers no pages now warns in the build log instead of publishing empty indexes silently.

## 0.3.3

### Patch Changes

- bbf432d: Stop treating request-conditional proxy matchers as route guards. A matcher with `has` or `missing` conditions (for example a header match on `accept`) runs the proxy only for some requests, so it no longer drops the routes it covers from `llms.txt`, `llms-full.txt`, and the `.md` twins; plain path matchers still exclude their routes.
- d218272: Fix the on-demand route returning an empty 500 for every request on serverless deployments such as Vercel. The build now adds the converter's platform-specific native binding to the route's file trace, the converter loads only when a page actually needs converting (so excluded and unknown `.md` routes return 404 even without it), and any remaining failure answers with a descriptive 503 or 500 and a server log line instead of an empty 500.

## 0.3.2

### Patch Changes

- 3b66565: Ship compiled declaration files in `dist` and point every `exports` types condition at them, so projects with stricter compiler options such as `noUncheckedIndexedAccess` no longer type-check the library's TypeScript source.

## 0.3.1

### Patch Changes

- fc0f031: Preserve existing public files and exact App Router routes instead of generating or rewriting over their llms.txt, llms-full.txt, and per-page Markdown surfaces.

## 0.3.0

### Minor Changes

- 4893957: Add `llmsfulltxt`, a complete `llms-full.txt` template callback with the same grouped sections as `llmstxt` plus each route's finalized publishable content.

## 0.2.4

### Patch Changes

- 6cf3ee7: Limit converted page frontmatter to `title` followed by `meta-description`.
