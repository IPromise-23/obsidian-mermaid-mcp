# Windows PowerShell Background Launcher for Obsidian Mermaid Watcher
$NodePath = (Get-Command node).Source
$ScriptPath = Join-Path $PSScriptRoot "..\..\packages\watcher\dist\index.js"
$VaultPath = "C:\Users\YourUsername\Documents\ObsidianVault"

Start-Process -FilePath $NodePath -ArgumentList "$ScriptPath watch --vault-root `"$VaultPath`" --apply --debounce-ms 2000" -WindowStyle Hidden
