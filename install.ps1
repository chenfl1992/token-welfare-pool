# Token 福利铺 — Windows 一键安装（PowerShell，普通用户权限即可）
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Defaults
param([switch]$Defaults)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host '==> 检查 Node.js'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw '需要 Node.js 22 LTS（>=22.19）。请先安装：https://nodejs.org'
}
$ver = (& node -p "process.versions.node").Trim().Split('.')
$major = [int]$ver[0]; $minor = [int]$ver[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19) -or $major -ge 25) {
  throw "Node 版本 $($ver -join '.') 不符合要求，请安装 22 LTS 或 24.x"
}
Write-Host "    Node v$($ver -join '.') OK"

Write-Host '==> 安装依赖'
Push-Location apps/freellmapi
npm ci
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'npm ci 失败' }
Write-Host '==> 编译服务端'
npm run build:server
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '编译失败' }
Pop-Location

Write-Host '==> 生成配置'
if ($Defaults) { node bootstrap/setup.mjs --defaults }
else { node bootstrap/setup.mjs }
if ($LASTEXITCODE -ne 0) { throw '配置生成失败' }

Write-Host '==> 注册开机自启（登录时启动）'
node bootstrap/control.mjs install-autostart

Write-Host '==> 启动服务'
node bootstrap/control.mjs start

Write-Host '==> 健康检查'
node bootstrap/doctor.mjs

$port = (Get-Content config/deployment.json -Raw | ConvertFrom-Json).apiPort
Write-Host ''
Write-Host "安装完成。打开管理页添加免费渠道：http://127.0.0.1:$port"
Write-Host '常用命令：node bootstrap/control.mjs status | stop | start'
