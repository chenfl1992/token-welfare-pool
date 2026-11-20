# workbuddy-freemodel

WorkBuddy 友好的 OpenAI 兼容代理。配置好至少一个上游 Provider 的 API key，
启动后任何 OpenAI 兼容客户端（WorkBuddy、Claude Code、Codex CLI、Hypit…）
把 `base_url` 指过来、调 `model: "auto"` 即可用。`auto` 在背后跑 bandit
评分 + 实时健康检查 + 自动失败回退，永远走当下能用的最好模型。

## 这是什么

字面看：是给 WorkBuddy 加"自定义模型"接入点的最小网关。

结构：
- 复用 [dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model)
  的 76 家 Provider 注册表（`src/providers/registry.json`，从原仓库 1:1 拷
  来，未改动）。
- 把原 dsh 面向 DeepSeek Harness (DSH) 的 adapter / cordis / schemastery
  那一层剥掉。
- 写一个新的 HTTP 网关（`index.js`），只暴露 4 个端点：
  - `GET  /v1/models`              → 返回 5 个虚拟 model（auto 系列）
  - `POST /v1/chat/completions`    → 入口，跑 auto-router
  - `GET  /health`                 → 免费存活探针 + 速览
  - `GET  /__internal/dashboard`   → 完整运行状态 JSON
- 在 `src/auto-router.js` 里实现借鉴自
  [freellmapi](https://github.com/tashfeenahmed/freellmapi) 的几个核心机制
  （精简实现，非全部特性）：
  - **3 维评分 + 凸组合 + 保护栏**：reliability × speed × intelligence
    加权组合，再乘 `headroomFactor × rateLimitFactor`。
  - **5 套预设策略**：`auto`（balanced）/ `auto:fast`（speed 优先）/
    `auto:smart`（intelligence 优先）/ `auto:reliable`（reliability 优先）/
    `auto:codex`（代码写作平衡）。
  - **Beta 后验 + Thompson sampling**：reliability 没有样本时给出乐观先验
    `Beta(1,1)`，避免新模型被冻结。
  - **per-model penalty**：429 加 3 分、其他失败加 1 分、120s 自动衰减 1 分。
  - **per-model cooldown**：失败事件按 `route/classify.js` 的合并词表分类
    （从 dsh 仓库 1:1 拷来，FCC × 9router 的合并版），冷却时长依规则确定。
  - **3 段回退**：单次请求最多 3 个候选（按 bandit 评分 + sticky 优先）。
  - **30 分钟 sticky session**：同一会话优先用上次那个 model，避免上下文
    切换。
  - **周期性 Provider 健康检查**（`health-probe.js`）：每小时一次浅探测
    `<baseUrl>/models`，落库到内存用于 `/__internal/dashboard`。

## 怎么跑

### 1. 安装

仓库即源码，零依赖（只跑 Node 22+，零 npm install）。

```bash
cd workbuddy-freemodel
```

### 2. 设置至少一个 Provider 的 API key

`auto` 现在只路由到 `process.env` 里 key 已就绪的 Provider。挑你想用的：

```bash
export GROQ_API_KEY=...        # Groq（推荐，速度好）
export OPENAI_API_KEY=...      # OpenAI
export ANTHROPIC_API_KEY=...   # Anthropic（注意：走的是 OpenAI 兼容层，
                               #           这里为了简化网关目前只接
                               #           openai-chat 和 openai-responses；
                               #           anthropic-messages 暂未转发）
export CEREBRAS_API_KEY=...    # Cerebras（也快）
export TOGETHER_API_KEY=...    # Together
# …其他 70+ 家见 src/providers/registry.json
```

每家 Provider 用的环境变量名是该行 `auth.env` 字段。

### 2b. 接入你自己的自定义模型（不在 76 家注册表里）

想接一个注册表没有的端点 —— 比如本地 Ollama / vLLM / LM Studio、公司内网
网关、自建推理服务、或任意兼容 OpenAI 的服务 —— 用一组 `CUSTOM_*` 环境变量
即可，无需改任何代码：

```bash
export CUSTOM_BASE_URL=http://127.0.0.1:8000/v1   # 必填。OpenAI 兼容的 base，含 /v1
export CUSTOM_API_KEY=sk-xxx                       # 可选。省略=无鉴权（本地服务）
export CUSTOM_MODEL_ID=my-model                    # 可选。模型 id，默认 custom-model。逗号分隔可填多个
export CUSTOM_MODEL_NAME="My Local Model"          # 可选。展示名
export CUSTOM_FORMAT=openai-chat                   # 可选。openai-chat(默认)|openai-responses|anthropic-messages
export CUSTOM_AUTH_SCHEME=Bearer                   # 可选。鉴权 scheme，默认 Bearer；可用 Token/Basic/apikey 等
export CUSTOM_EXTRA_HEADERS='{"x-foo":"bar"}'      # 可选。JSON，附加请求头
```

接好后：

- `GET /v1/models` 里会多出一条 `custom/<modelId>`，可直接 dial。
- `model: "auto"` 也会把它纳入 bandit 评分，和健康检查的 Provider 一起参与
  排序与回退（冷启动给 +0.05 偏置，保证它至少被诚实试一次）。
- 想绕过 auto、强制打到你的端点：直接 `model: "custom/<modelId>"`。

验证它就跟其它 Provider 一样：

```bash
curl -sS -X POST http://127.0.0.1:18899/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"custom/my-model","messages":[{"role":"user","content":"hi"}]}'
```

返回里带 `_provider: "custom"` / `_model: "<modelId>"`，方便你审计实际打到了哪。

### 3. 启动

```bash
node index.js
# or
PORT=18999 node index.js
```

默认监听 `http://127.0.0.1:18899`。日志会列出当前检测到的 Provider：

```
[workbuddy-freemodel] listening on http://127.0.0.1:18899
[workbuddy-freemodel] env-based provider list:
  - groq :: llama-3.3-70b-versatile  (Llama 3.3 70B)
  - groq :: qwen/qwen3-32b  (Qwen3 32B)
  - openai_api :: gpt-5-mini  (GPT-5 Mini)
  ...
```

### 4. 在 WorkBuddy（或其他兼容客户端）里指过来

```jsonc
{
  "base_url": "http://127.0.0.1:18899/v1",
  "api_key": "not-needed",
  "model": "auto"
}
```

或者你硬要指定某家：

```jsonc
{ "model": "groq/llama-3.3-70b-versatile" }
```

## 端点

### `GET /v1/models`

只返回 5 个虚拟 model（`auto` + `auto:fast`/`smart`/`reliable`/`codex`）。
这是为了让 WorkBuddy/Codex/Claude Code 这类选择器的"Model"下拉始终
干净，不会被 76 家 Provider × 几百个 model 淹没。

要看每个 Provider 每个 model 的运行时分数、cooldown、penalty：
去看 `GET /__internal/dashboard`。

### `POST /v1/chat/completions`

OpenAI 标准兼容体，支持 `stream: true` 与 `false`。

**支持的 `model` 字段值：**

| 值 | 行为 |
| --- | --- |
| `auto` | balanced bandit，挑当前最高分 + 不在 cooldown 的 model |
| `auto:fast` | speed 优先 |
| `auto:smart` | intelligence 优先 |
| `auto:reliable` | reliability 优先 |
| `auto:codex` | 略偏 intelligence + 略偏 speed 的代码写作平衡 |
| `groq/llama-3.3-70b-versatile` | 直命中某家某模型（不回退，4xx 中断） |

**Sticky session**：传 `conversation` / `session` / `user` 字段，或
`x-session-id` / `x-conversation-id` HTTP 头；同一值下 30 分钟内会保持
用同一 Provider/Model。

**回退行为：**
- 单次请求最多试 3 个候选。
- 每次失败 → `route/classify.js` 给 verdict → 写 cooldown + penalty
  → 选下一候选。
- 4xx 不重试（request-scoped，不会对同一份 payload 重发）。
- 5xx / 429 / 超时 → 重试下一个。
- 流式请求里如果中途中断，已发出 SSE 帧不可撤回，只把兜底错误帧附
  在末尾。

### `GET /health`

```
{"ok":true,"providers_with_keys":3,"candidates":17,"cooldowns":1,
 "penalties":0,"recent_probes":[]}
```

### `GET /__internal/dashboard`

完整 JSON：所有候选、运行时 sample 计数、cooldowns、penalties、最近一次
健康探测结果。运维要排错去这里。

## 与 dsh-our-free-model 的差别

| 维度 | dsh 原版 | workbuddy-freemodel |
| --- | --- | --- |
| 宿主 | DSH 插件（cordis patch + ssr + hmr + 7 页毛玻璃 UI） | 独立 Node 进程 + 4 个 HTTP 端点 |
| Provider 来源 | 76 家注册表 + 4 条免密车道 + 用户 Key 渠道 | 只用 76 家注册表（key-based） |
| 模型清单 | 全部聚合（约 800+ 个 model 行） | 只 5 个 `auto*` 虚拟 model |
| 路由策略 | 用户手写 combo 链 | bandit + auto 链 |
| UI | 客户端 SPA | 无（用 `__internal/dashboard` 排错） |
| 持久化 | `settings.json` 0600 | 全部内存（重启清空） |
| 自更新 | OTA + Ed25519 验签 | 无（手动重启） |

## 与 freellmapi 的关系

freellmapi 是更大、更完整的产品（自带 UI、SQLite 加密 db、Vision/Doc/
Codex 多模态、原生 Anthropic 端点、多账户预算管理…）。本项目**只**借鉴
它的以下设计：

- scoring.ts 的 3 维凸组合 + 保护栏乘子（精简后保留 balanced/smartest/
  fastest/reliable 预设 + 自己加 codex）。
- router.ts 的 per-model penalty/decay（保留 3/1 权重、120s 衰减、上限 10）。
- health.ts 的周期性 provider probe 设计（精简为 1 小时 1 次、单 key 探测）。
- cooldown-probe.ts 的"过半冷却期才探"原则（未实现此模块，但 cooldown
  表本身支持拓展）。

**没有借鉴**它的：UI / Express 服务器 / SQLite / 加密 / 配对 / 多 profile
 / 视觉能力判定 / Fusion 多模型合成 / 商业订阅目录同步。

## 安全警告

- 原 dsh 的免密车道（Kilo 等）声明上游可能记录 prompt；本项目**未启用**
  免密车道，避免这种风险。
- Provider `auth.env` 仅写入 `process.env`，本进程不持久化任何 key。
- 一旦配置 ≥1 个 Provider 的 key，所有走 WorkBuddy 出去的请求都会被路由
  到 Provider。建议为 workbuddy 的"自定义模型"连接单独建一组受限 key，
  不要复用你的生产主 key。
- 浏览器访问 `http://127.0.0.1:18899/__internal/dashboard` 不会泄露 key
  本体，只暴露 hasKey 推断和 provider id。

## 限制

- 仅实现 `openai-chat` / `openai-responses` 两种线（registry 里多数是这
  两种）。原 dsh 还有 `anthropic-messages`（如 Z.ai、minimax-cn）的本地
  转发，本项目暂未迁移 — 用了 Anthropic 端点的 Provider（z.ai/glm、
  minmax-cn）当前不能跑。
- 没有 vision input 的特殊处理（registry 里 `vision: true` 的 model 在
  bandit's intelligence 轴上只是有信噪，没有做内容过滤）。
- 没有 Anthropic SDK 兼容的 `/v1/messages`（要 Claude Code 适配需另写
  一个转换层）。
- 没有持久化 — 重启清空所有 cooldown/penalty/sticky。
- 没有 TLS（仅 127.0.0.1 监听，不暴露公网）。
- 没有 quota 多账户轮换（每家 Provider 一个 key，没接 per-key RPM/RPD 计数）。
- 没有 user-level 鉴权 — 任何能在本机 127.0.0.1 访问到的人都能调用。要对外
  暴露务必加 nginx 鉴权或前置 reverse proxy。

## 文件清单

```
workbuddy-freemodel/
├── index.js                       # 网关入口（4 端点 HTTP 服务）
├── package.json                   # scripts: start, typecheck
├── README.md                      # 本文件
├── src/
│   ├── auto-router.js             # bandit + sticky + fallback 主路径
│   ├── scoring.js                 # 3 维评分 + Beta sampling（freellmapi 借鉴）
│   ├── penalty.js                 # per-model penalty + 2min 衰减
│   ├── cooldown.js                # per-(provider, model, key) 冷却表
│   ├── active-providers.js        # env 扫描，过滤出当前可路由的候选
│   ├── models.js                  # 5 个 auto* 虚拟 model
│   ├── health-probe.js            # 1 小时一次 <baseUrl>/models 探活
│   ├── route/classify.js          # 失败分类词表（直接复用原版，未改）
│   └── providers/
│       ├── index.js               # Provider 注册表加载（直接复用原版，未改）
│       └── registry.json          # 76 家 Provider 数据（直接复用原版，未改）
```

## 致谢

- [dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model)
  — Provider 注册表、`route/classify.js` 合并词表
- [freellmapi](https://github.com/tashfeenahmed/freellmapi)
  — bandit 评分、penalty/cooling、health-probe 设计

## License

MIT
