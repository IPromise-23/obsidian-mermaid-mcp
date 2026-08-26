# Docker Deployment Guide / Docker 部署与使用指南

<p align="left">
  <a href="../README.md">English</a> | <a href="../README.zh-CN.md">简体中文</a>
</p>

`obsidian-mermaid-mcp` provides first-class Docker support. Packaging Node.js, Chromium, and CJK fonts into a container guarantees **zero host dependency installation** and **consistent cross-platform rendering** on macOS, Linux, Windows, WSL, and headless servers.

本项目提供官方 Docker 容器化支持，容器内已预装 Node.js、Chromium 以及中日韩（CJK）字体库，彻底解决宿主机缺少 Chrome 或中文字体渲染乱码的问题。

---

## 1. Quick Build / 构建镜像

Build the local image:

```bash
docker build -t obsidian-mermaid-mcp:latest .
```

---

## 2. Mode A: MCP Server over Stdio / 模式 A：作为 MCP Server 供 AI Agent 调用

You can configure any MCP client (Claude Code, Cursor, Windsurf, Cline, Roo Code, etc.) to start the Docker container on demand.

### Critical Requirement / 关键技术要求
- Use `-i` (interactive stdin stream).
- **Do NOT use `-t`** (allocating a pseudo-TTY corrupts JSON-RPC streaming with escape codes).
- Mount your Obsidian vault to `/vault` via `-v`.

### Claude Code / Cursor / Windsurf Configuration

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

### OpenAI Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.obsidian_mermaid]
command = "docker"
args = [
  "run",
  "-i",
  "--rm",
  "-v",
  "/absolute/path/to/your/vault:/vault",
  "-e",
  "OBSIDIAN_MERMAID_VAULT_ROOT=/vault",
  "obsidian-mermaid-mcp:latest"
]
```

---

## 3. Mode B: Background Watcher Daemon / 模式 B：后台常驻 Watcher 自动监听

Run the watcher as a persistent background container. Any Mermaid blocks written to your Obsidian vault will be automatically converted to embedded SVGs within 2 seconds.

### Using Docker Run / 单行命令运行

```bash
docker run -d \
  --name obsidian-mermaid-watcher \
  --restart unless-stopped \
  -v /absolute/path/to/your/vault:/vault \
  obsidian-mermaid-mcp:latest \
  watch --apply --debounce-ms 3000
```

- **View Logs / 查看运行日志**:
  ```bash
  docker logs -f obsidian-mermaid-watcher
  ```
- **Stop Container / 停止容器**:
  ```bash
  docker stop obsidian-mermaid-watcher
  ```

### Using Docker Compose / 使用 Docker Compose

Set `VAULT_PATH` and start:

```bash
VAULT_PATH=/absolute/path/to/your/vault docker compose up -d
```

Or create a `.env` file next to `docker-compose.yml`:
```env
VAULT_PATH=/absolute/path/to/your/vault
```
Then simply run:
```bash
docker compose up -d
docker compose logs -f
```

---

## 4. Why Use Docker? / 为什么推荐 Docker 部署？

| Feature / 特性 | Local Node.js / 本地安装 | Docker Container / 容器化 |
| :--- | :--- | :--- |
| **Node.js Requirement** | Requires Node.js `>=20` | Zero host dependencies / 宿主机免装 Node |
| **Browser Dependency** | Requires local Chrome/Chromium | Bundled Chromium in image / 内置 Chromium |
| **CJK Font Rendering** | Depends on host OS fonts | Pre-installed `fonts-noto-cjk` / 内置全套中文字体 |
| **Cross-Platform** | Requires manual path config on Windows/Linux | Uniform across macOS, Linux, Windows, WSL |
| **Host Isolation** | Full host filesystem access | Restricted to `/vault` volume mount only |
