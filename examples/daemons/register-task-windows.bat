@echo off
REM Registers obsidian-mermaid-watcher as a Windows Scheduled Task (Runs at Logon)
set NODE_EXE=node
set WATCHER_JS=%~dp0..\..\packages\watcher\dist\index.js
set VAULT_ROOT=C:\path\to\your\obsidian\vault

schtasks /Create /TN "ObsidianMermaidWatcher" /TR "\"%NODE_EXE%\" \"%WATCHER_JS%\" watch --vault-root \"%VAULT_ROOT%\" --apply --debounce-ms 3000" /SC ONLOGON /RL HIGHEST /F
echo Task ObsidianMermaidWatcher created successfully!
pause
