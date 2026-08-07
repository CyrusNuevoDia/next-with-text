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

Building locally leaves nothing behind: the generated files exist only for the deploy build that needs them ([details](#generated-files-clean-up-after-themselves)).

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

## Generated files clean up after themselves

Building locally leaves your working tree exactly as it was. Nothing to gitignore, nothing to review, no diff noise:

- **`app/%5Fllms/`** — the two-line route file that powers on-demand conversion. It's written when the build or dev server starts and deleted when that process exits (Next's typegen reference to it is scrubbed too, so your editor never shows a dangling import). While `next dev` is running the file stays put, and a `next build` in another terminal won't pull it out from under the dev server.
- **`public/llms.txt`, `public/llms-full.txt`, `public/<route>.md`** — the static tier, written only when the build is a **deploy** build. Locally they're never written, and any left over from an earlier deploy build get reclaimed.

A deploy build is one where `CI` or `VERCEL` is set — true on Vercel, GitHub Actions, and essentially every CI runner. If you build the artifact you actually deploy somewhere those aren't set (a self-hosted box, a release script on your laptop), open the gate by hand:

```bash
NEXT_WITH_TEXT_STATIC=1 next build
```

The same variable set to `0` forces local behavior anywhere, including CI. With `output: "standalone"` the files are also written into `.next/standalone/public` on every build — that tree is the deployable artifact, never your working copy — so a standalone build shouldn't need the override. That path hasn't been verified on a real standalone deploy yet; set `NEXT_WITH_TEXT_STATIC=1` if you'd rather not rely on it.

Local `next start` serves every surface identically — the on-demand route covers what the static files would have. It's a request-time HTML conversion rather than a file read, so it's slower than production, and it's the only difference you'll see.

Files you edit by hand are never deleted: pruning removes a file only when its contents still match what the last build wrote.

If a dev server is killed with `SIGKILL` (or your machine loses power), `app/%5Fllms/` can survive — the next build or dev run clears it. Gitignore it if a crash-leftover in `git status` would bother you:

```gitignore
app/%5Fllms/
```

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
