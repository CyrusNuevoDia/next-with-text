# Audience

Who `next-with-text` is for, who actually consumes its output, and what each group forces on the design. Companion to `shaping.md` (what we're building, and the prior art it improves on).

## Two audiences, and only one of them is human

The person who installs the package and the agents that read its output have almost nothing in common, and conflating them produces bad decisions. The developer judges the package in the first minute after install — does one line in `next.config.ts` produce the surfaces, does the build stay green, does anything gated leak. The agents judge it on every fetch afterward — is `/llms.txt` spec-shaped, are the `.md` files actual page content, do the listed URLs resolve. The developer decides adoption; the agents decide whether adoption was worth anything. Every design question should know which of the two it's answering.

## The installing developer

Three personas, ordered by intent:

1. **Docs-site maintainers.** They already know what llms.txt is — they've seen Mintlify and Fumadocs ship it — and their docs live in a custom App Router site or Nextra. Smallest group, highest intent, and the harshest graders of output fidelity, because their users paste docs URLs into Claude and Cursor and complain when code blocks come back mangled. They're also the group most likely to hit our edges first: MDX pages, large route counts, `generateStaticParams` at scale. When conversion quality slips, this is who files the issue.

2. **SaaS and product-site owners chasing AI visibility.** They've heard "AI SEO" / "AEO" and want ChatGPT, Claude, and Perplexity to cite them. Much larger group, much lower patience: they will not write config, they will not curate a route list, and their marketing pages share an app with auth-gated dashboards. The zero-config default and the auth-safety invariant (gated pages absent from static surfaces by construction, proxy matchers auto-excluded) exist for this persona — they'd never configure either, so both have to be free. Whatever the README shows first has to be the one-liner, because the one-liner is the whole pitch they'll read.

3. **Agencies and template authors who ship many Next sites.** They adopt once and apply everywhere, which makes them a distribution channel — but only if the package needs no per-site tuning. Convention over configuration isn't taste here, it's what makes the plugin spreadable; every option we add is a reason this group writes a wrapper or skips us.

Two traits cut across all three. They deploy to Vercel or `output: "standalone"`, so serverless correctness is table stakes — and it's also the incumbent's verified failure (its own demo serves an empty index and 404s every page URL), which makes "works where you actually deploy" the comparison we should lead with. And they evaluate npm packages in under a minute on README, download count, and last-publish date, which means the README's first screen carries more adoption weight than any feature below the fold.

## The machine audience

The output consumers are the real users, and they come in three shapes:

- **llms.txt-aware crawlers and indexers** fetch `/llms.txt` and follow its links. They need the spec template (`# title`, `> description`, link lines), concrete URLs rather than `[slug]` patterns, and titles/descriptions that survive `generateMetadata` — which is why entries come from rendered HTML metadata, never from source-file guessing.
- **Coding agents and chat assistants** fetch individual pages mid-task, either at `<route>.md` or via `Accept: text/markdown` on the canonical URL. They need the actual page body as clean markdown — headings, code fences, images as references — because a title-and-description stub (what the incumbent serves) is indistinguishable from a broken endpoint to an agent trying to read the page. Content fidelity is this audience's entire experience of the product.
- **Bulk-ingest pipelines** grab `/llms-full.txt` once to feed a context window or an index. They need per-page sections under URL headers and no HTML or RSC residue, and they're the reason frontmatter is stripped inside sections but kept on standalone `.md` files.

Agents don't file issues; they just fail silently and the site owner never learns why they aren't being cited. So this audience's requirements can't be discovered from feedback — they have to be encoded in the test suite, which is effectively the machine audience's advocate in the repo.

## Who it's not for

- **Pages Router apps.** The mechanism reads App Router build output; there's no path to Pages Router without a second architecture. The incumbent's README claims this and doesn't deliver it — we say no upfront instead.
- **Non-Next frameworks.** The whole value is riding Next's build; anything portable would have to give that up.
- **Hand-curators.** A team that wants a fully bespoke, hand-written `/llms.txt` should put a static file in `public/` — no library needed. The `llmstxt` function covers the middle ground (custom template over auto-discovered routes), but full manual curation is out of scope by design.
- **People who want a markdown CMS.** `export const md` is an override for pages whose rendered HTML converts poorly, not an authoring system. If most pages need the override, this is the wrong tool.

## Bottom line

Build for persona 2's install experience and the agents' read experience, and let persona 1 stress-test fidelity. Concretely: the zero-config path is the product, auth safety must never depend on configuration, and output quality is verified against what an agent sees rather than what a human skims. The condition that would shift this: if docs-site maintainers turn out to dominate adoption, index customization (sections, curated entries) moves up the priority list — that's the `llmstxt` escape hatch's audience, and demand there is the signal to watch.
