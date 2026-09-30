# next-with-text

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
