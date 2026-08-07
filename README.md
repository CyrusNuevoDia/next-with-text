# next-with-text

llms.txt for Next.js — one line in `next.config.ts`.

```bash
npm install next-with-text
```

```ts
// next.config.ts
import { withText } from "next-with-text";

export default withText(nextConfig);
```

That's the entire integration. Your app now serves:

- **`/llms.txt`** — a spec-compliant [llmstxt.org](https://llmstxt.org) index of your pages, with real titles and descriptions
- **`/llms-full.txt`** — every page's full content as markdown, in one file, for bulk ingestion
- **`/<route>.md`** — a markdown twin of every page (`/about` → `/about.md`)
- **`Accept: text/markdown`** — agents that ask a canonical URL for markdown get markdown; browsers are unaffected

No route handlers to write, no middleware, no config files, no route lists to maintain. It reads your build output — not your source tree — so nothing it needs disappears in a serverless bundle. ChatGPT, Claude, Perplexity, and coding agents can read your site the way they want to.

Requires Next.js 16+ and the App Router.

## Why this exists

AI assistants increasingly decide what to cite by what they can read. Next.js has no first-class way to serve LLM-consumable content, so sites either hand-roll markdown endpoints or reach for tools that scan the source tree and serve title-and-description stubs at best — and a stub is indistinguishable from a broken endpoint to an agent trying to read the page.

`next-with-text` derives everything from your build. It walks the HTML that `next build` actually rendered — `generateMetadata`, `generateStaticParams`, MDX, whatever produced the page — and converts it to clean markdown: headings, code fences, images as absolute-URL references. Dynamic routes like `/blog/[slug]` show up as concrete URLs (`/blog/hello-world`), not patterns. If a page prerenders and isn't excluded, it's in the index.

Every surface is asserted by a test suite that builds a real Next app — file-level checks on the build output, HTTP checks against `next start` and `next dev`.

## Auth safety, by construction

Pages behind auth never leak into the static output — the generation mechanism can't publish them:

- The static surfaces (`llms.txt`, `llms-full.txt`, the `.md` files) are generated **only from HTML that `next build` prerendered**. An auth-gated page reads `cookies()` or `headers()`, or redirects — so Next marks it dynamic and emits no build HTML for it. There's nothing to publish, so nothing leaks; there is no exclude list to forget.
- Routes guarded by your `proxy.ts` (middleware) are excluded too, even when they're statically prerenderable: `withText` reads the compiled matchers from the build output and drops every matching route from all static surfaces. Also automatic — a `matcher: ["/admin/:path*"]` means no `/admin` in either index and no published `admin.md`.

Auth-gated dynamic pages still get `.md` and Accept negotiation, safely: they're converted on demand by fetching the page with **the requester's own cookies**, so `/account.md` renders exactly what `/account` would show that visitor.

## Options

Zero config is the intended config — the same one line works unchanged in every app you ship. When you need more:

```ts
export default withText(nextConfig, {
  md: true, // default true — the .md twins + Accept negotiation
  include: ["**/*"], // route-path globs (routes, not file paths)
  exclude: [], // excluded routes vanish from every surface: both indexes,
  // no .md file, and the on-demand route 404s them
  llmstxt: (ctx) => "…", // optional: its return value IS the entire llms.txt body
});
```

`llms.txt` and `llms-full.txt` are always generated. The index groups pages by first path segment (`/docs/**` → `## Docs`), root pages listed first — no section config to maintain:

```markdown
# Acme

> Payments infrastructure for platforms.

- [Pricing](/pricing.md): Plans and per-transaction fees.

## Docs

- [Getting started](/docs/getting-started.md): Install and make your first charge.
```

### Per-page override: `export const md`

For pages whose rendered HTML converts poorly, export `md` from the page file. It replaces the converted content for that page everywhere (`.md` file, `llms-full.txt`, Accept negotiation):

```tsx
// app/docs/setup/page.tsx
import type { MarkdownPage } from "next-with-text";

export const md: MarkdownPage = `# Setup\n\nHand-written markdown for this page.`;
```

All of these work:

```tsx
// plain string
export const md: MarkdownPage = "…";

// object — title/description also replace this page's entry in both indexes
export const md: MarkdownPage = { title: "…", description: "…", content: "…" };

// function, sync or async, with typed params for dynamic routes
export const md: MarkdownPage<"/tags/[tag]"> = async ({ params }) =>
  `# ${(await params).tag}`;
```

Functions also receive `searchParams` — real values during on-demand conversion, `{}` at build time.

### Custom index: the `llmstxt` function

If the default template isn't right, take over the whole file:

```ts
llmstxt: ({ title, description, routes }) =>
  [
    `# ${title}`,
    `> ${description}`,
    "",
    "## Docs",
    ...routes
      .filter((r) => r.href.startsWith("/docs"))
      .map((r) => `- [${r.title}](${r.href}): ${r.description}`),
  ].join("\n");
```

`routes` is the final route list — filtered, auth-excluded, with any `md` overrides applied. This only affects `llms.txt`; `llms-full.txt` has no knobs.

## Setup notes

Add the generated artifacts to `.gitignore` — they're rebuilt on every `next build` (adjust the `.md` pattern if you keep your own markdown files in `public/`):

```gitignore
public/llms.txt
public/llms-full.txt
public/**/*.md
app/%5Fllms/
```

`app/%5Fllms/` is a directory holding the two-line route file `withText` generates to power on-demand conversion (dev, dynamic pages, and any request no static file covers). It's regenerated automatically — gitignore it and forget it.

## What it's not for

- **Pages Router** — the mechanism reads App Router build output; there's no Pages Router support and none planned.
- **Fully hand-curated indexes** — if you want a bespoke, hand-written `llms.txt`, put a static file in `public/`; you don't need a library for that. The `llmstxt` function covers the middle ground: your template over auto-discovered routes.
- **Markdown authoring** — `export const md` is an escape hatch for pages that convert poorly, not a CMS. If most of your pages need it, this is the wrong tool.

## Development

```bash
bun install
bun run test   # builds the library, then runs the verifier suite against tests/fixtures/next
```

The test suite builds a fixture Next app, inspects the build output, and asserts over HTTP against `next start` and `next dev` — including auth exclusion, cookie-forwarded on-demand conversion, and Accept negotiation.

## License

MIT
