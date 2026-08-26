# Security model

The configured vault root is the only file-system authority. Every incoming
path is checked for absolute paths, traversal, NUL bytes, non-Markdown note
targets, and symlink escapes. Expanded attachment templates must remain below
the root and include a content hash or block id.

SVG output is bounded, parsed as XML, and stripped of scripts, event-handler
attributes, external URL references, embedded objects, and external entities.
Remote CSS `url()` and `@import` references are rejected as well.
The renderer uses Mermaid `securityLevel: strict` and does not request remote
icon packs. The server does not expose HTTP and does not connect to
Mermaid2Img.

Writes require `apply=true`, use same-directory temporary files, fsync, and
atomic rename. A second note fingerprint check prevents a render from
overwriting an edit made while Chromium was running. Failed renders leave the
source fence and previous successful assets untouched.
