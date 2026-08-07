---
"next-with-text": minor
---

Gated pages can now be listed on purpose, without publishing what's behind them.

A page opts in by exporting `md` with a title and no content — `export const md = { title: "Your account", description: "Billing and settings. Requires sign-in." }`. The route appears in `llms.txt`, `llms-full.txt` carries that metadata plus a `[Requires session]` link instead of a body, and no `.md` file is written, so the route keeps rendering live with the caller's own cookies. Supply a `content` alongside the title and that text becomes the published body. This works for both kinds of gated route: pages the build prerendered no HTML for, and statically prerenderable pages your `proxy.ts` matcher guards.

Nothing is published that you didn't write in the page file — a gated page's own rendering is never the source. Routes with dynamic segments can't opt in (there are no concrete URLs to publish), `exclude` patterns still win over any export, and every build names the routes that opted in.

The same rule now governs every page: an `md` export declaring a title but no content publishes no body anywhere, so `llms-full.txt` gets a stub instead of the page's markdown.

On-demand `.md` responses rendered from a caller's cookies are sent `Cache-Control: private, no-store`, so a CDN caching without `Vary: Cookie` can't serve one visitor's page to another.

A build also removes any `public/<route>.md` sitting at the path of a route that publishes no body, whatever wrote it — a file left by an earlier build would otherwise shadow the live per-requester render.

**Breaking:** the `llmstxt` function's context now carries `sections` instead of a flat `routes`, so you can do your own sectioning: `{ title, description, sections: [{ title, routes: [{ title, description, href }] }] }`. The first section has an empty `title` and holds the root-level pages the index opens with; sections with no routes are never passed. Migrate with `ctx.sections.flatMap((s) => s.routes)` to get the old flat list.
