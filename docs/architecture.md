# Architecture

```text
MCP host (Codex / Claude Code)
        │ stdio JSON-RPC
        ▼
packages/mcp-server ───────────────┐
        │                          │ no watcher startup
        ▼                          │
packages/core: scanner → renderer → sanitizer → atomic commit
        ▲
        │
packages/watcher (independent process, explicit --apply)
```

The core package has no MCP or Obsidian dependency. It owns the reversible
Markdown transformation, hash/cache policy, vault path boundary, SVG metadata,
and transaction checks. The renderer is an adapter because Mermaid CLI's Node
API is not covered by semver. Browser creation is lazy: handshake and
`tools/list` do not launch Chromium; the first uncached render does. The
install skips browser downloads; runtime uses `PUPPETEER_EXECUTABLE_PATH` or a
detected local Chrome/Chromium binary.

## Sync transaction

1. Resolve and validate the vault-relative note path.
2. Read content and record SHA-256, size, and mtime.
3. Scan Mermaid fences without reformatting unrelated Markdown.
4. Render and sanitize each candidate; create metadata and sidecar plans.
5. Re-read the note fingerprint.
6. If unchanged and `apply=true`, atomically write assets and then Markdown.

Preview (`apply=false`) runs the same planning path but writes nothing.

## Managed block

Each successful replacement has a JSON marker immediately above an Obsidian
embed. The marker stores the source hash, asset paths, and enough fence
metadata to reconstruct the original fence. Source is stored in both SVG
metadata and a `.mmd` sidecar by default.
