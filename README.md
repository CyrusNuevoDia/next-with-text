# next-with-text

llms.txt for Next.js — in 3 simple steps.

```bash
npm install next-with-text
```

```ts
// next.config.ts
import { withText } from "next-with-text";

export default withText(nextConfig);
```

```gitignore
# .gitignore
**/app/%5Fllms/
```

That's the entire integration. Your app now serves:

- **`/llms.txt`** — a spec-compliant [llmstxt.org](https://llmstxt.org) index of your pages, with real titles and descriptions
- **`/llms-full.txt`** — every page's full content as markdown, in one file, for bulk ingestion
- **`Accept: text/markdown`** — agents that ask a canonical URL for markdown get markdown; browsers are unaffected
- **`/<route>.md`** — a markdown twin of every page (`/about` → `/about.md`)

No route handlers to write, no middleware, no config files, no route lists to maintain. It reads your build output — not your source tree — so nothing it needs disappears in a serverless bundle. ChatGPT, Claude, Perplexity, and coding agents can read your site the way they want to.

Building locally leaves nothing behind: the generated files exist only for the deploy build that needs them ([details](#generated-files-clean-up-after-themselves)).

Requires Next.js 16+ and the App Router.

## Options

Zero config is the intended config — the same one line works unchanged in every app you ship. When you need more:

```ts
export default withText(nextConfig, {
  md: true, // default true — the .md twins + Accept negotiation
  include: ["**/*"], // route-path globs (routes, not file paths)
  exclude: [], // excluded routes vanish from every surface: both indexes,
  // no .md file, and the on-demand route 404s them
  llmstxt: (ctx) => "…", // optional: its return value IS the entire llms.txt body
  // ctx is { title, description, sections: [{ title, routes: [{ title, description, href }] }] }
  llmsfulltxt: (ctx) => "…", // optional: owns llms-full.txt with the same ctx shape
  // every route in llmsfulltxt also has its finalized publishable content
});
```

`llms.txt` and `llms-full.txt` are generated unless your app already owns that route. The index groups pages by first path segment (`/docs/**` → `## Docs`), root pages listed first — no section config to maintain:

## Auth safety, by construction

By default, pages behind auth never leak into the static output — the generation mechanism can't publish them. Listing one is possible, but only as [a deliberate opt-in](#listing-a-gated-page-on-purpose) written into the page itself.

- The static surfaces (`llms.txt`, `llms-full.txt`, the `.md` files) are generated **only from HTML that `next build` prerendered**. An auth-gated page reads `cookies()` or `headers()`, or redirects — so Next marks it dynamic and emits no build HTML for it. There's nothing to publish, so nothing leaks; there is no exclude list to forget.
- Routes guarded by your `proxy.ts` (middleware) are excluded too, even when they're statically prerenderable: `withText` reads the compiled matchers from the build output and drops every matching route from all static surfaces. Also automatic — a `matcher: ["/admin/:path*"]` means no `/admin` in either index and no published `admin.md`.

Auth-gated dynamic pages still get `.md` and Accept negotiation, safely: they're converted on demand by fetching the page with **the requester's own cookies**, so `/account.md` renders exactly what `/account` would show that visitor. Those responses are sent `Cache-Control: private, no-store`, so a CDN that caches without varying on `Cookie` can't hand one visitor's page to the next.

### Listing a gated page on purpose

Sometimes you want an agent to know a page exists — an account area, a guarded reports section — without publishing what's behind it. A page opts in by exporting `md` with a title and no content:

```tsx
// app/account/page.tsx
export const md = {
  title: "Your account",
  description: "Billing, plan, and settings. Requires sign-in.",
};
```

That entry appears in `llms.txt`; `llms-full.txt` carries the same metadata plus a `[Requires session]` link instead of a body; no `account.md` file is written, so `/account.md` keeps rendering live with the caller's cookies. Add a `content` alongside the title and that text becomes the published body — useful for a guarded page you want to describe properly.

The safety property is unchanged, because the opt-in is an allowlist and everything it publishes is text you wrote in the page file — the page's rendering is never the source. Three things hold it in place:

- **Only literal routes.** `/users/[id]` can't opt in: there are no concrete URLs to publish without enumerating your customers.
- **`exclude` still wins.** A route matched by an `exclude` pattern stays dark no matter what it exports, so config remains a reliable kill switch.
- **It's never quiet.** Every build prints the routes that opted in by name: `2 gated route(s) opted into the index via md export: /admin/reports, /gated`.

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

Functions also receive `searchParams`, just like standard `PageProps`.

### Custom index: the `llmstxt` function

If the default template isn't right, take over the whole file:

```ts
llmstxt: ({ title, description, sections }) =>
  [
    `# ${title}`,
    `> ${description}`,
    ...sections.flatMap((section) => [
      "",
      section.title && `## ${section.title}`,
      ...section.routes.map(
        (r) => `- [${r.title}](${r.href}): ${r.description}`
      ),
    ]),
  ]
    .filter(Boolean)
    .join("\n");
```

`sections` is the final route list, grouped the way the default index groups it — filtered, auth-excluded, with any `md` overrides applied. The first section has an empty `title`: those are the root-level pages the index opens with, before any heading. A section is only present when it has routes, so you never have to guard against empty ones. Regroup them however you like; this only affects `llms.txt`.

### Custom full text: the `llmsfulltxt` function

The full-text callback mirrors `llmstxt`: it owns the whole file and receives the same title, description, sections, route grouping, and ordering. Each route also carries its finalized `content`:

```ts
llmsfulltxt: ({ title, description, sections }) =>
  [
    `# ${title}`,
    `> ${description}`,
    ...sections.flatMap((section) => [
      section.title && `## ${section.title}`,
      ...section.routes.map(
        (route) => `${route.content}\n\n[Source](${route.href})`
      ),
    ]),
  ]
    .filter(Boolean)
    .join("\n\n");
```

`content` is exactly what the default `llms-full.txt` would publish for that route: frontmatter is removed, `md` content overrides rendered HTML, gated opt-ins become safe stubs, and excluded or non-publishable routes never reach the callback.

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

Existing surfaces always win. A file such as `public/llms.txt`, or an exact App Router handler such as `app/llms-full.txt/route.ts` or `app/about.md/route.ts`, makes next-with-text skip that output entirely — it doesn't render the body, invoke its customization callback, write a static file, or install a rewrite over your route. This applies independently to both indexes and every per-page `.md` twin. Files recorded in the build manifest are still next-with-text outputs, so later builds update them normally; editing one by hand transfers ownership to you. A custom per-page `.md` route remains linked from `llms.txt`, and `llms-full.txt` references it instead of publishing a second rendering of the underlying page.

If a dev server is killed with `SIGKILL` (or your machine loses power), `app/%5Fllms/` can survive — the next build or dev run clears it.

## Why this exists

AI assistants increasingly decide what to cite by what they can read. Next.js has no first-class way to serve LLM-consumable content, so sites either hand-roll markdown endpoints or reach for tools that scan the source tree and serve title-and-description stubs at best — and a stub is indistinguishable from a broken endpoint to an agent trying to read the page.

`next-with-text` derives everything from your build. It walks the HTML that `next build` actually rendered — `generateMetadata`, `generateStaticParams`, MDX, whatever produced the page — and converts it to clean markdown: headings, code fences, images as absolute-URL references. Dynamic routes like `/blog/[slug]` show up as concrete URLs (`/blog/hello-world`), not patterns. If a page prerenders and isn't excluded, it's in the index.

Every surface is asserted by a test suite that builds a real Next app — file-level checks on the build output, HTTP checks against `next start` and `next dev`.

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
