---
"next-with-text": patch
---

Stop treating request-conditional proxy matchers as route guards. A matcher with `has` or `missing` conditions (for example a header match on `accept`) runs the proxy only for some requests, so it no longer drops the routes it covers from `llms.txt`, `llms-full.txt`, and the `.md` twins; plain path matchers still exclude their routes.
