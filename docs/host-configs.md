# Host Configuration Guide / 客户端配置指南

`obsidian-mermaid-mcp` complies with the Model Context Protocol (MCP) specification and works seamlessly with all MCP-compatible AI hosts and agents.

本文提供主流 AI 工具与 Agent 的 MCP 配置示例（JSON 与 TOML）。

---

## 1. Claude Code

Edit `~/.claude/mcp.json` or `~/.config/claude/mcp.json` (or add via `claude mcp add`):

```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"],
      "env": {
        "OBSIDIAN_MERMAID_VAULT_ROOT": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

---

## 2. OpenAI Codex CLI

In your Codex configuration file (e.g. `~/.codex/config.toml`):

```toml
[mcp_servers.obsidian_mermaid]
command = "node"
args = ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"]

[mcp_servers.obsidian_mermaid.env]
OBSIDIAN_MERMAID_VAULT_ROOT = "/absolute/path/to/your/vault"
# Optional: explicitly specify chrome path if not detected automatically
# PUPPETEER_EXECUTABLE_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

---

## 3. Google Antigravity / Gemini CLI

In your Antigravity MCP settings or `.gemini/antigravity/settings.json`:

```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"],
      "env": {
        "OBSIDIAN_MERMAID_VAULT_ROOT": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

---

## 4. Cursor (IDE)

In Cursor Settings -> **Features** -> **MCP Servers** -> **Add new MCP server**:
- **Name**: `obsidian-mermaid`
- **Type**: `command` (stdio)
- **Command**: `node /absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js`
- **Environment Variables**:
  - `OBSIDIAN_MERMAID_VAULT_ROOT`: `/absolute/path/to/your/vault`

Or in `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"],
      "env": {
        "OBSIDIAN_MERMAID_VAULT_ROOT": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

---

## 5. Windsurf (Codeium)

In `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"],
      "env": {
        "OBSIDIAN_MERMAID_VAULT_ROOT": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

---

## 6. Cline / Roo Code (VS Code Extension)

In Cline/Roo Code Settings -> **MCP Servers** (or `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"],
      "env": {
        "OBSIDIAN_MERMAID_VAULT_ROOT": "/absolute/path/to/your/vault"
      },
      "disabled": false,
      "autoApprove": [
        "extract_mermaid_source",
        "render_mermaid",
        "sync_note",
        "restore_note"
      ]
    }
  }
}
```

---

## 7. Goose (Block MCP Agent)

In `~/.config/goose/config.yaml` or UI:

```yaml
extensions:
  obsidian_mermaid:
    cmd: node
    args:
      - /absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js
    envs:
      OBSIDIAN_MERMAID_VAULT_ROOT: /absolute/path/to/your/vault
    type: stdio
```

---

## 8. Zed Editor

In Zed `settings.json`:

```json
{
  "context_servers": {
    "obsidian-mermaid": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js"],
        "env": {
          "OBSIDIAN_MERMAID_VAULT_ROOT": "/absolute/path/to/your/vault"
        }
      }
    }
  }
}
```

---

## 9. 使用自定义配置文件 (Optional Config File)

也可以不使用 `OBSIDIAN_MERMAID_VAULT_ROOT` 环境变量，而是直接传入 `--config` 参数：

```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "node",
      "args": [
        "/absolute/path/to/obsidian-mermaid-mcp/packages/mcp-server/dist/index.js",
        "--config",
        "/absolute/path/to/config.json"
      ]
    }
  }
}
```

---

## 10. Docker 容器化 MCP 配置 (Universal Docker Host Config)

如果使用 Docker 运行 MCP Server，任何支持 stdio 的客户端均可配置为 `command: "docker"`：

```json
{
  "mcpServers": {
    "obsidian-mermaid": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/absolute/path/to/your/vault:/vault",
        "-e",
        "OBSIDIAN_MERMAID_VAULT_ROOT=/vault",
        "obsidian-mermaid-mcp:latest"
      ]
    }
  }
}
```

> **注意**：必须保留 `-i`，**绝对不能加 `-t`**（TTY 会污染 JSON-RPC 消息流）。详细说明请查阅 [`docs/docker-guide.md`](docker-guide.md)。

