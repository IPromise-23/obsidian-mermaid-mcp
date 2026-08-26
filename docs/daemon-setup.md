# Cross-Platform Background Watcher Setup / 跨平台后台守护进程配置

The watcher daemon allows any AI Agent (Codex, Claude Code, Antigravity, Cursor, Windsurf, Cline, etc.) to write standard Markdown notes with ` ```mermaid ` fences, and have them automatically converted into embedded SVGs without manual tool calls or user confirmation.

本指南介绍如何在 **macOS**, **Linux**, **Windows** 上将 Watcher 配置为后台开机自启常驻服务。

---

## macOS (LaunchAgent / launchd)

macOS 用户推荐使用 `LaunchAgent`，在用户登录时自动启动并在崩溃时自动重启。

### 1. 查找 Node 绝对路径
```bash
which node
# 例如: /opt/homebrew/bin/node 或 /usr/local/bin/node
```

### 2. 创建并编辑 plist 文件
复制模板到 `~/Library/LaunchAgents/`：
```bash
cp examples/daemons/com.obsidian-mermaid.watch.plist ~/Library/LaunchAgents/com.user.obsidian-mermaid-watch.plist
```

编辑 `~/Library/LaunchAgents/com.user.obsidian-mermaid-watch.plist`，修改以下几个字段为真实绝对路径：
- `ProgramArguments` 中的 node 路径（如 `/opt/homebrew/bin/node`）
- `ProgramArguments` 中的 watcher 脚本路径（如 `/Users/username/obsidian-mermaid-mcp/packages/watcher/dist/index.js`）
- `--vault-root` 后的 Vault 路径（如 `/Users/username/MyVault`）
- `WorkingDirectory` 设为仓库根目录
- 日志文件路径 `StandardOutPath` / `StandardErrorPath`

### 3. 加载与启动服务
```bash
# 载入并启动
launchctl load ~/Library/LaunchAgents/com.user.obsidian-mermaid-watch.plist

# 检查运行状态
launchctl list | grep obsidian

# 查看运行日志
tail -f ~/Library/Logs/obsidian-mermaid-watch.err.log
```

### 4. 停止与卸载服务
```bash
launchctl unload ~/Library/LaunchAgents/com.user.obsidian-mermaid-watch.plist
```

---

## Linux (systemd user service)

Linux 用户推荐使用 systemd 用户级服务（不需要 root 权限）。

### 1. 查找 Node 路径
```bash
which node
# 例如: /usr/bin/node 或 /home/user/.nvm/versions/node/v20.x.x/bin/node
```

### 2. 创建 systemd 服务文件
```bash
mkdir -p ~/.config/systemd/user/
cp examples/daemons/obsidian-mermaid-watch.service ~/.config/systemd/user/
```

编辑 `~/.config/systemd/user/obsidian-mermaid-watch.service`，更新 `ExecStart`、`WorkingDirectory` 以及 Vault 路径。

### 3. 启用并启动服务
```bash
# 重载 systemd 配置
systemctl --user daemon-reload

# 启动服务并设置开机自启
systemctl --user enable --now obsidian-mermaid-watch.service

# 查看服务状态
systemctl --user status obsidian-mermaid-watch.service

# 查看实时日志
journalctl --user -u obsidian-mermaid-watch.service -f
```

---

## Windows (Task Scheduler / PowerShell)

Windows 用户可通过任务计划程序（Task Scheduler）实现登录时后台静默启动。

### 方法一：使用批处理快速注册任务计划程序
1. 以文本编辑器打开 `examples/daemons/register-task-windows.bat`。
2. 将 `VAULT_ROOT` 修改为你 Obsidian 仓库的绝对路径（如 `C:\Users\Username\Documents\MyVault`）。
3. 右键选择 **以管理员身份运行** 该脚本。
4. 任务将在每次用户登录时静默启动后台 node 监听进程。

### 方法二：PowerShell 静默启动
修改 `examples/daemons/start-watcher.ps1` 中的 Vault 路径，然后执行：
```powershell
powershell -ExecutionPolicy Bypass -File examples\daemons\start-watcher.ps1
```

---

## 常用调试排错

1. **修改防抖时间**：默认为 2000ms（2秒）。若需要更短响应时间，可在参数中增加 `--debounce-ms 1000`。
2. **确认写入模式**：必须包含 `--apply` 参数，否则 Watcher 仅为预览模式（不会修改磁盘文件）。
