# Security policy

`obsidian-mermaid-mcp` is a local file tool. Treat the configured vault root as
the trust boundary. The server refuses absolute paths, traversal, symlink
escapes, non-Markdown note targets, oversized source, and unsafe SVG content.

The stdio server does not open a network listener and does not use Mermaid2Img
or any online rendering service. Mermaid is rendered with a local adapter and
`securityLevel: strict`; external URL fetching is not part of the contract.

Only an explicit `apply: true` permits writes. Writes use same-directory
temporary files and atomic rename, and a note fingerprint is checked again
before commit to avoid overwriting concurrent edits. Generated SVGs and
sidecars are never garbage-collected automatically.

Please report suspected vulnerabilities privately before public disclosure.
Do not include vault contents, cookies, API keys, or other credentials in a
report.
