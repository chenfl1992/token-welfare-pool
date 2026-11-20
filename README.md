# Token 福利铺 · token-welfare-pool

> 给 AI 新手和高频用户谋 token 福利：把分散的免费模型渠道，打包成一个**自动签到、自动绕限流、自动挑最快模型**的 OpenAI 兼容网关。
>
> 客户端只填一个地址，剩下的它自己搞定。

本项目基于 [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi) 与 [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) 二次整合，附带改造版 OFM 独立网关、跨平台一键安装、开机自启和健康检查。

---

## 核心能力

| 能力 | 说明 |
|---|---|
| 免费渠道聚合 | OFM 网关统一接入 DSH 系列免费渠道，新模型自动同步 |
| 自动签到 | 启动后 30 秒、每天 00:05、失败后每 6 小时补签，当天去重 |
| 智能路由 | 可用性优先：**不限流 > 响应快 > 更智能**，429 自动绕行、冷却自动恢复 |
| 单入口 `my-group` | 文本自动走最快文本模型，带图自动走视觉模型，不再返回调不通的"僵尸模型" |
| 标准协议 | OpenAI 兼容 `/v1`、`/v1/models`、`/v1/chat/completions`，支持流式与工具调用 |
| 一键安装 | macOS / Linux / Windows 三条命令起服务，自动注册开机自启 |
| 健康检查 | 一条命令检查端口、依赖、模型接口、分组与实际调用 |

架构一句话：

```
客户端 → freellmapi (3001，调度/签到/分组) → OFM 网关 (18899，免费渠道) → 各免费平台
                    ↑ 可选 Cloudflare 隧道 → 固定公网地址
```

---

## 快速开始

### macOS / Linux

```bash
git clone <你的仓库地址> token-welfare-pool
cd token-welfare-pool
./install.sh                 # 交互式，回车用默认值
# 或： ./install.sh --defaults  # 端口 3001/18899、启用 OFM 与自启，全程无人值守
```

### Windows（PowerShell，普通用户权限）

```powershell
git clone <你的仓库地址> token-welfare-pool
cd token-welfare-pool
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 或加 -Defaults 使用推荐配置
```

环境要求：**Node.js 22.19+ 或 24.x**（推荐 22 LTS）、npm 10+、可访问 npm registry。

安装脚本会依次完成：检查 Node → `npm ci` → 编译服务端 → 生成配置 → 注册开机自启 → 启动服务 → 健康检查。配置只写入本机 `config/deployment.json` 和 `apps/freellmapi/.env`，**不会提交到仓库**。

### 首次使用（关键三步）

1. 打开管理页 `http://127.0.0.1:3001`，注册管理员账号；启动日志里首次会打印一次性设置码。
2. 添加至少一个免费渠道（DSH 渠道填 OFM 网关的转发密钥，`http://127.0.0.1:18899/v1`），等待模型同步。
3. 创建单入口分组并检查：

```bash
node bootstrap/seed-group.mjs     # 从当前可用模型创建 my-group
node bootstrap/doctor.mjs         # 健康检查，含一次真实调用
```

---

## 接入你的智能体

任何支持 OpenAI 兼容自定义端点的客户端都能接：

| 参数 | 填写内容 |
|---|---|
| Base URL | `http://127.0.0.1:3001/v1`（本机）或你的公网地址 |
| API Key | 管理页里的 `unified_api_key`（形如 `freellmapi-...`） |
| Model | `my-group`（推荐）、`auto` 或具体模型 id |

WorkBuddy 用户编辑 `~/.workbuddy/models.json`：

```json
{
  "id": "my-group",
  "name": "my-group",
  "vendor": "Custom",
  "url": "http://127.0.0.1:3001/v1/",
  "apiKey": "freellmapi-<你的统一密钥>",
  "supportsToolCall": true,
  "supportsImages": true
}
```

⚠️ 改完配置后**必须新开一个对话**：旧会话持有启动时的模型快照，会报 `no endpoint url configured (4100)`。

---

## 常用命令

```bash
node bootstrap/control.mjs status              # 查看服务状态
node bootstrap/control.mjs stop                # 停止服务
node bootstrap/control.mjs start               # 启动服务
node bootstrap/control.mjs install-autostart   # 重新注册开机自启
node bootstrap/control.mjs uninstall-autostart # 移除开机自启
node bootstrap/doctor.mjs                      # 健康检查
node bootstrap/seed-group.mjs                  # 重建 my-group
node bootstrap/setup.mjs                       # 重新配置（会覆盖本机配置）
```

---

## 目录结构

```
.
├── install.sh / install.ps1      # 三平台一键安装
├── bootstrap/
│   ├── setup.mjs                 # 配置向导
│   ├── control.mjs               # 服务控制与开机自启
│   ├── doctor.mjs                # 健康检查
│   ├── seed-group.mjs            # 创建 my-group 单入口
│   └── lib.mjs                   # 共用工具
├── apps/
│   ├── freellmapi/               # 定制主程序（签到、门控、视觉分流）
│   └── ofm-gateway/              # 改造版免费渠道聚合网关
├── config/                       # 本机配置与生成文件（已忽略）
└── docs/                         # 完整教程
```

---

## 文档

- [安装指南](docs/安装指南.md) — 三平台详细步骤、首次配置渠道、升级与卸载
- [工作原理](docs/工作原理.md) — 四层架构、签到调度、路由排名、视觉分流
- [接入客户端](docs/接入客户端.md) — WorkBuddy / Codex / Gemini，工具调用与常见报错
- [公网与自启](docs/公网与自启.md) — 局域网共享、Cloudflare 隧道、三平台自启、数据持久化
- [排障手册](docs/排障.md) — 高频问题的原因与解决
- [从零讲给 AI 新手](docs/从零讲给AI新手.md) — 含「Token 羊毛铺」人设的完整实战故事

---

## 安全与合规

- `config/deployment.json`、`apps/freellmapi/.env`、`apps/freellmapi/server/data/`、`ofm-data/` 含密钥与账号信息，已加入 `.gitignore`，**请勿提交**。
- 公网暴露后，任何拿到「地址 + Key」的人都能调用；建议强随机 Key 或 Cloudflare Access 做访问控制。
- 请遵守各上游平台的条款，合理使用免费资源；本项目不对第三方服务的可用性或政策变化负责。
- 上游代码许可见 `apps/freellmapi/LICENSE` 与 `apps/ofm-gateway/LICENSE`；本项目新增脚本采用 MIT 许可。
