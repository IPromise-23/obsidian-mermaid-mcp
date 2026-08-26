# Contributing

Use Node.js 20+, keep changes inside the package that owns them, and run the
full verification sequence before opening a pull request:

```bash
npm ci && npm run typecheck && npm test && npm run lint && npm run build
```

Do not include vault files, credentials, browser state, or generated assets in
commits. New write behavior must preserve preview mode and concurrent-edit
checks.
