---
"next-with-text": patch
---

Ship compiled declaration files in `dist` and point every `exports` types condition at them, so projects with stricter compiler options such as `noUncheckedIndexedAccess` no longer type-check the library's TypeScript source.
