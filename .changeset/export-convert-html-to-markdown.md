---
"next-with-text": minor
---

Export `convertHTMLtoMarkdown(html)` from the package entry: it turns an HTML string into the same markdown next-with-text writes for a page's `.md` twin (inline SVGs, data-URL images and the footer dropped; frontmatter limited to `title` and `meta-description`). `ConverterUnavailableError` and the `ConversionResult` type are exported alongside it. The function loads the converter's native addon on first call, so it is Node.js-only.
