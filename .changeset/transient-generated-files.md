---
"next-with-text": minor
---

Generated files no longer linger in your working tree.

`app/%5Fllms/` is deleted when the build or dev server that generated it exits, and Next's typegen reference to it is scrubbed so your editor never reports a dangling import. A `next build` in another terminal won't delete the route out from under a running dev server.

The `public/` tier (`llms.txt`, `llms-full.txt`, `<route>.md`) is now written only for deploy builds — those with `CI` or `VERCEL` set, which covers Vercel and every mainstream CI runner. A local build writes nothing and reclaims what an earlier deploy build left, including the directories it empties; files you've edited by hand are kept. Local `next start` serves every surface through the on-demand route instead. Set `NEXT_WITH_TEXT_STATIC=1` to force the static tier when building a deployment outside CI, or `0` to force it off.
