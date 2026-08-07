# F5/F6/F7 Spike: HTML→md engine, build-time acquisition, .md serving — RESULTS

Status: **complete**. All questions answered empirically against `tests/fixtures/next` (Next 16.3.0, Turbopack, 12 prerender workers). The probe code lives in the fixture (`next.config.ts` exit hook, `middleware.ts`, `app/md/[...path]/route.ts`, `app/llms-full.txt/route.ts`).

## Verdict

Everything runs inside `next build` via an **exit-hook patch**: a `withLlms()` wrapper in `next.config.ts` registers `process.once("exit")` during `phase-production-build`; when it fires, all prerendered HTML exists, and the hook converts it and overwrites the llms routes' own `.body`/`.meta` outputs in `.next`. Route handlers still own the routes (registration, dev serving, on-demand fallback); the hook only fills in their static content.

## Findings by question

**F6-Q1 — in-handler read during prerender: NO, definitively.**
Run 1: at handler execution, `.next/server/app` existed but held **zero** `.html` files. Run 2 (polling probe + 3s-slow page): HTML appears _incrementally_ (7 files visible at ~510ms), but 2 paths (`/`, `/zebra`) never appeared in 15s — they were queued on the worker the probe was occupying. Waiting inside a handler starves same-worker paths; partial results are nondeterministic. Any in-prerender strategy is unsound.

**F6-Q1b — exit hook (replacement mechanism): YES.**
`process.once("exit")` registered at config load fires exactly once, in the main build process only (workers never fired it), after all static generation: it saw all 9 HTML files and the route's emitted `.body`. `beforeExit` does NOT fire (Next calls `process.exit()`), so the hook's work must be synchronous — fine, the converter is sync. Guard needed: bail if the build failed before emitting our routes (probe hit ENOENT on a failed build).

**F6-Q2 — post-build CLI: moot** (rejected by R3 before testing).

**F5-Q1 — conversion fidelity: excellent.**
`@xberg-io/html-to-markdown` (npm, v3.10.6, native addon, **sync**, ~1.7ms/page): headings, lists, code fences, links, images all survive; RSC payload `<script>`s vanish; `preprocessing.removeNavigation: true` (default) drops the nav; `excludeSelectors: ["footer"]` drops the footer; `extractImages: false` (default) keeps images as plain references — no data URIs. Output includes YAML frontmatter (title + meta-description). Remaining engine work: absolutize relative URLs against the site URL; decide frontmatter policy (keep for `.md` pages, probably strip inside llms-full sections).

**F5-Q2 — metadata: fully resolved values.**
`convert().metadata.document` returns the final rendered title (template applied: "About Us | Fixture Site") and description — including for the dynamic `/blog/hello` page whose metadata comes from `generateMetadata`. This is the R4 mechanism.

**F5-Q3 — dev / never-prerendered paths:** in `next dev` there is no `.next/server/app/*.html`; acquisition there is self-fetch of the dev server (not yet exercised in the spike, mechanism uncontroversial). Same fallback covers dynamic paths not in `generateStaticParams` and serverless runtimes without the built HTML on disk.

**F7-Q1 — `.md` URLs via middleware: YES.**
Middleware rewrite `/<path>.md` → `/md/<path>` + `app/md/[...path]/route.ts` works cleanly on `next start` (`/about.md`, nested `/docs/getting-started.md` both 200 with markdown). No conflict with pages.

**F7-Q2 — Accept negotiation: YES.**
`Accept: text/markdown` (and not `text/html` — browsers stay unaffected) on `/about` rewrites to markdown; plain requests get HTML. RSC/client-nav requests are unaffected (they accept `text/x-component`). Matcher excludes `_next`, `api`, `favicon.ico`.

**F7-Q3 — catch-all-without-middleware alternative:** not tested; middleware is required for Accept negotiation anyway, so it's the single mechanism for both.

## Constraints discovered

- **`withText()` config wrapper is mandatory** — the exit hook can only be registered from `next.config.ts` (the one module evaluated in the build's main process). It also must set `serverExternalPackages: ["@xberg-io/html-to-markdown"]` — Turbopack cannot bundle the native addon into route handlers without it. This amends R3.
- Exit-hook work must be synchronous (`process.exit()` semantics).
- The hook must verify build success + completeness before patching, and tolerate workers (empirically they don't fire it, but guard anyway).
- Native addon ships per-platform binaries; cross-platform deploys rely on optionalDependencies resolution (WASM build exists as fallback if a platform is missing).
- Untested but structurally sound: Vercel uploads `.next` after the build command exits, so patched `.body` files are what gets deployed. Verify on a real deploy during implementation.

## Addendum: per-page `export const txt`/`md` overrides (spike-proven)

Adding `export const txt = () => string` / `export const md = async () => string` to `app/about/page.tsx`:

- `next build` accepts the extra exports (no route-export validation error).
- They survive bundling into `.next/server/app/about/page.js` — no tree-shaking loss.
- A plain Node process can evaluate them: set `globalThis.AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage` (else Next's ALS shim throws E504 on require), `require()` the compiled `page.js`, walk `routeModule.userland.loaderTree` — each tree node is `[segment, parallelRoutes, mods]`; the `__PAGE__` leaf's `mods.page` is `[loader, path]`; calling the loader (promise-based) yields the userland module: keys `["default", "md", "metadata", "txt"]`, and both `txt()` (sync) and `md()` (async) returned their strings.
- Consequence: because loading is promise-based and `md` may be async, and the `exit` hook is sync-only, the patch step must run in a `spawnSync`'d child Node script (parent hook stays sync; child awaits freely).
- Open implementation detail: evaluating overrides in `next dev` (dev-compiled module layout differs from `.next/server/app`). Moot for v1 — Shape G dropped dev serving entirely.

## Addendum 2: public-file serving + config-rewrite negotiation (Shape G, spike-proven)

- Files written into `public/` **after** `next build` completes are served by `next start` (live fs read) — so the exit hook can write `public/llms.txt`, `public/llms-full.txt`, `public/<route>.md` and they serve with zero routes, zero middleware.
- Config-injected Accept negotiation works without middleware: `rewrites().beforeFiles` entry with `source: "/:path((?!_next|api|.*\\.md$).*)"` and `has: [{ type: "header", key: "accept", value: "(?!.*text/html).*text/markdown.*" }]`, destination `/:path.md`. Verified: `Accept: text/markdown` → serves the public `.md`; browser-like Accept containing `text/html` → normal HTML; plain requests → HTML.
- Consequence: no user files at all besides the `withText()` line — route handlers, md route, middleware, and the stub-manifest mechanism are all deleted from the design. `serverExternalPackages` is also unnecessary now (converter runs only in the exit-hook child process, outside the bundle).
- New residual risks: Vercel post-build `public/` collection (expected to work, untested on real deploy); `output: "standalone"` copies `public/` possibly before the exit hook fires (mirror writes into `.next/standalone` if present); stale-output pruning across rebuilds.

## Addendum 3: dev sidecar (Shape G dev serving, spike-proven)

- In `phase-development-server`, code in `next.config.ts` module/function scope runs inside the long-lived dev process: spawning an `http.createServer` sidecar there works (`unref()` + swallow `EADDRINUSE` for double config loads).
- Dev-only `beforeFiles` rewrites proxy to absolute localhost URLs: `/llms.txt`, `/llms-full.txt`, `/:path(.*\\.md)`, and the Accept-negotiation rewrite all verified against `next dev` — sidecar receives the requests; plain page requests still return dev HTML.
- The proxied request carries `x-forwarded-host: <dev origin>` — the sidecar self-fetches page HTML from there per request (which also triggers dev compilation of the page) and converts live. Cookies forward through the proxy, so authenticated pages can render the requester's own view in dev.
- Dev evaluation of page `txt`/`md` overrides remains an open implementation detail (dev-compiled module layout); acceptable v1 degradation: dev serves HTML-converted markdown without overrides.

## Addendum 4: proxy auto-exclusion + prod sidecar / on-demand tier (spike-proven)

- **Proxy matchers are readable at build**: with a `proxy.ts` (Next 16; `export default function proxy` + `config.matcher`), `.next/server/functions-config-manifest.json` exposes `functions["/_middleware"].matchers[]` with compiled `regexp` AND `originalSource` (e.g. `"/admin/:path*"`). (`middleware-manifest.json` stays empty in Next 16 — wrong place to look.) The exit child tests discovered routes against these regexes and auto-excludes matches from all static surfaces.
- **`next.config` also loads at `phase-production-server`** — the sidecar spawns fine inside `next start`.
- **Build-baked `fallback` rewrites reach the sidecar**: `fallback: [{ source: "/:path(.*\\.md)", destination: "http://127.0.0.1:<port>/:path" }]` fires only when no public file/page matched. Verified: `public/about.md` wins for prerendered pages; `/account.md` (dynamic page, no file) reaches the sidecar; request cookies forward (`cookie=session=abc123` observed), and `x-forwarded-host` carries the origin — so on-demand conversion is cookie-aware (authed `.md` renders the requester's view).
- Serverless: no config-load persistence → no sidecar → the fallback rewrite dead-ends (404) for non-prerendered `.md`. Graceful; documented; a later opt-in route file could cover serverless dynamic pages.
- New implementation details: sidecar port selection/collision (option with sane default; the port is baked into rewrites at build so build and start must agree), and the Accept-negotiation rewrite's interplay with fallback (beforeFiles rewrite to `/:path.md` → no file → fallback catches it → sidecar; chain works by construction, assert in verifier).

## Addendum 5: unified on-demand route — sidecar deleted (spike-proven)

User direction: one mechanism across dev/start/serverless, codegen blessed, URL preference `/_llms/:path`. Result — all verified:

- **Underscore gotcha**: `app/_llms/**` never mounts (leading-underscore folders are routing-private). The escape is a folder named `%5Fllms` (URL-encoded underscore) → mounts at `/_llms/:path`. Build output confirms `ƒ /_llms/[...path]`.
- **Codegen at config load works**: `withText` writes `app/%5Fllms/[...path]/route.ts` if absent (config loads before route discovery in build; dev watcher picks it up). Real library generates a 2-line re-export; gitignored.
- **WASM converter FAILS under bundling**: `@xberg-io/html-to-markdown-wasm` throws `__wbindgen_add_to_stack_pointer` undefined in a bundled route (its nodejs target loads the `.wasm` via `__dirname`, which bundling breaks). Solution: use the native `@xberg-io/html-to-markdown` in the route with `serverExternalPackages` (set internally by `withText`) — the sharp pattern; Vercel traces the platform binary.
- **End-to-end on `next start`**: `/account.md` → fallback rewrite → `/_llms/account.md` → self-fetch with forwarded cookies → converted markdown (`session=abc123` reflected); Accept negotiation chains beforeFiles → fallback → route (`session=xyz` reflected).
- **End-to-end on `next dev`**: same route, zero build artifacts — `/about.md`, cookie-aware `/account.md`, and Accept negotiation all serve converted markdown.
- Earlier "route 404" results in this session were invalid (stale server on the port — `EADDRINUSE` in server.log); always check the server actually started.
- The sidecar (addendums 3–4's dev/prod HTTP server) is deleted from the design — the codegen'd route covers every environment, and serverless dynamic `.md` now needs zero user files.
