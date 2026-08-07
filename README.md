# next-with-text

llms.txt for Next.js — one line in `next.config.ts`.

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

No route handlers, no middleware, no config files, no route lists to maintain. ChatGPT, Claude, Perplexity, and coding agents can read your site the way they want to.

## Why this exists

AI assistants increasingly decide what to cite by what they can read. Next.js has no first-class way to serve LLM-consumable content, so everyone hand-rolls markdown endpoints and hand-curates route lists that drift from the real app.

`next-with-text` derives everything from your build. It walks the HTML that `next build` actually rendered — `generateMetadata`, `generateStaticParams`, MDX, whatever produced the page — and converts it to clean markdown. Dynamic routes like `/blog/[slug]` show up as concrete URLs (`/blog/hello-world`), not patterns. If a page renders, it's covered; if you delete it, it disappears.

Because it reads build output rather than scanning your source tree, it works where you actually deploy: `next dev`, `next start`, Vercel, and `output: "standalone"` all serve the same surfaces through the same mechanism.

## Auth safety, by construction

Pages behind auth never leak into static output — not because you configured an exclude, but because gated pages are dynamic (they read `cookies()` or `headers()`, or redirect) and dynamic pages produce no build HTML to publish. Routes covered by your `proxy.ts` matcher are excluded automatically too.

Dynamic pages still get `.md` and Accept negotiation: they're converted on demand, with the requester's cookies forwarded, so `/account.md` renders *your* account exactly like `/account` does — and stays invisible to everyone else.

## Options

Zero config is the intended config. When you need more:

```ts
export default withText(nextConfig, {
  md: true,          // default true — the .md twins + Accept negotiation
  include: ["**/*"], // route-path globs (routes, not file paths)
  exclude: [],       // excluded routes vanish from every surface: both indexes,
                     // no .md file, and the on-demand route 404s them
  llmstxt: (ctx) => "…", // optional: its return value IS the entire llms.txt body
});
```

`llms.txt` and `llms-full.txt` are always generated. The index groups pages by first path segment (`/docs/**` → `## Docs`), root pages listed first — no section config to maintain.

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

Install:

```bash
npm install next-with-text
```

Add the generated artifacts to `.gitignore` — they're rebuilt on every `next build`:

```gitignore
public/llms.txt
public/llms-full.txt
public/**/*.md
app/%5Fllms/
```

Requires Next.js 16+ and the App Router.

## What it's not for

- **Pages Router** — the mechanism reads App Router build output; there's no Pages Router support and none planned.
- **Fully hand-curated indexes** — if you want a bespoke, hand-written `llms.txt`, put a static file in `public/`; you don't need a library for that. The `llmstxt` function covers the middle ground: your template over auto-discovered routes.
- **Markdown authoring** — `export const md` is an escape hatch for pages that convert poorly, not a CMS. If most of your pages need it, this is the wrong tool.

## Development

```bash
bun install
bun run test   # builds the library, then runs the verifier suite against tests/fixtures/next
```

The test suite builds a fixture Next app and asserts over HTTP against `next build` output, `next start`, and `next dev` — including auth exclusion, cookie-forwarded on-demand conversion, and Accept negotiation.

## License

MIT
