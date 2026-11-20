#!/usr/bin/env bash
# Token 福利铺 — macOS / Linux 一键安装
#   ./install.sh              交互式配置
#   ./install.sh --defaults   全部采用推荐值（端口 3001 / 18899，启用 OFM 与自启）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "==> 检查 Node.js"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "需要 Node.js 22 LTS（>=22.19）。请先安装：https://nodejs.org"
  exit 1
fi
MAJOR="$(node -p "process.versions.node.split('.')[0]")"
MINOR="$(node -p "process.versions.node.split('.')[1]")"
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 19 ]; } || [ "$MAJOR" -ge 25 ]; then
  echo "Node 版本 v${MAJOR}.${MINOR} 不符合要求，请安装 Node.js 22 LTS 或 24.x"
  exit 1
fi
echo "    Node v$(node -v) ✓"

echo "==> 安装依赖"
(cd apps/freellmapi && npm ci)

echo "==> 编译服务端"
(cd apps/freellmapi && npm run build:server)

echo "==> 生成配置"
node bootstrap/setup.mjs "$@"

echo "==> 注册开机自启"
node bootstrap/control.mjs install-autostart

echo "==> 启动服务"
node bootstrap/control.mjs start

echo "==> 健康检查"
node bootstrap/doctor.mjs || true

echo
echo "安装完成。打开管理页添加免费渠道：http://127.0.0.1:$(node -p "JSON.parse(require('fs').readFileSync('config/deployment.json')).apiPort")"
echo "常用命令：node bootstrap/control.mjs status | stop | start"
