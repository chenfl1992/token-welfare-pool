#!/usr/bin/env node
// 安装后自检：配置 / 依赖 / 端口 / 模型接口 / 分组 / 公网入口。
import fs from 'node:fs';
import {
  CONFIG_PATH, DB_PATH, readConfig, portOpen, httpJson, unifiedKey, readSetting,
} from './lib.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('\nToken 福利铺 — 健康检查\n');

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = (major === 22 && minor >= 19) || major === 24;
  check('Node 版本', nodeOk, `v${process.versions.node}（建议 22.19+ 或 24）`);
  check('部署配置', fs.existsSync(CONFIG_PATH), CONFIG_PATH);
  check('数据库', fs.existsSync(DB_PATH), DB_PATH);

  let cfg;
  try { cfg = readConfig(); } catch { cfg = null; }

  const key = unifiedKey();
  check('依赖与统一密钥', Boolean(key), key ? '已就绪' : '请先 npm ci 并启动一次服务');

  if (cfg) {
    const apiUp = await portOpen(cfg.apiPort, cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host);
    check(`freellmapi 端口 ${cfg.apiPort}`, apiUp);

    if (cfg.ofmEnabled) {
      const ofmUp = await portOpen(cfg.ofmPort);
      check(`OFM 网关端口 ${cfg.ofmPort}`, ofmUp);
    }

    if (apiUp && key) {
      try {
        const base = `http://127.0.0.1:${cfg.apiPort}`;
        const data = await httpJson(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
        const ids = (data?.data ?? []).map(m => m.id);
        check('模型接口', ids.length > 0, `${ids.length} 个模型可用`);

        const raw = readSetting('model_unify_overrides');
        const overrides = raw ? JSON.parse(raw) : { merges: [] };
        const group = (overrides.merges ?? []).find(m => m.into === 'my-group');
        check('my-group 单入口', Boolean(group), group ? `${group.keys.length} 个成员` : '运行 node bootstrap/seed-group.mjs 创建');

        if (group) {
          try {
            const reply = await httpJson(`${base}/v1/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
              body: JSON.stringify({ model: 'my-group', messages: [{ role: 'user', content: '只回复 OK' }], max_tokens: 16 }),
            });
            const content = reply?.choices?.[0]?.message?.content ?? '';
            check('my-group 实际调用', Boolean(content), String(content).slice(0, 40).replace(/\s+/g, ' '));
          } catch (error) {
            check('my-group 实际调用', false, error.message.slice(0, 120));
          }
        }
      } catch (error) {
        check('模型接口', false, error.message.slice(0, 140));
      }
    }

    if (cfg.publicUrl) {
      try {
        const data = await httpJson(`${cfg.publicUrl.replace(/\/$/, '')}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        });
        check('公网入口', Boolean(data), cfg.publicUrl);
      } catch (error) {
        check('公网入口', false, error.message.slice(0, 120));
      }
    }
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    console.log('\n✓ 全部检查通过。可以接入 WorkBuddy / 其他智能体了。\n');
    return;
  }

  console.log(`\n✗ ${failed.length} 项需要修复：`);
  const hints = {
    'Node 版本': '安装 Node.js 22 LTS（>=22.19）后重新执行安装脚本。',
    '部署配置': '执行 node bootstrap/setup.mjs。',
    '数据库': '执行 node bootstrap/control.mjs start，让服务自动建库。',
    '依赖与统一密钥': '在 apps/freellmapi 执行 npm ci && npm run build:server，然后启动服务。',
    '模型接口': '打开管理页添加至少一个免费渠道并填入密钥，再刷新模型列表。',
    'my-group 单入口': '执行 node bootstrap/seed-group.mjs。',
    'my-group 实际调用': '查看 config/generated/freellmapi.log；若渠道被限流，等待冷却或补充渠道。',
    '公网入口': '确认 cloudflared 已安装且隧道模式配置正确，或暂时关闭公网入口仅本机使用。',
  };
  for (const item of failed) {
    const hint = hints[item.name] ?? '查看 docs/排障.md。';
    console.log(`  · ${item.name}：${hint}`);
  }
  console.log('');
}

main().catch((error) => { console.error(`\n✗ 检查中断：${error.message}\n`); process.exit(1); });
