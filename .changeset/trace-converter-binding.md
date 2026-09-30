---
"next-with-text": patch
---

Fix the on-demand route returning an empty 500 for every request on serverless deployments such as Vercel. The build now adds the converter's platform-specific native binding to the route's file trace, the converter loads only when a page actually needs converting (so excluded and unknown `.md` routes return 404 even without it), and any remaining failure answers with a descriptive 503 or 500 and a server log line instead of an empty 500.
