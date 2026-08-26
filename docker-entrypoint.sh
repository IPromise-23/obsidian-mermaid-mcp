#!/bin/sh
set -e

if [ "$1" = "watch" ]; then
    shift
    exec node packages/watcher/dist/index.js watch --vault-root "${OBSIDIAN_MERMAID_VAULT_ROOT:-/vault}" "$@"
elif [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ]; then
    exec node packages/mcp-server/dist/index.js "$@"
else
    exec "$@"
fi
