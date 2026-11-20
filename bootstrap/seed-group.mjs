#!/usr/bin/env node
// 从当前可用模型创建 my-group 单入口：文本走快模型，图片走视觉模型。
import { createRequire } from 'node:module';
import {
  DB_PATH, FREAPI_DIR, readConfig, httpJson, unifiedKey, readSetting,
} from './lib.mjs';

const require = createRequire(import.meta.url);

function writableDb() {
  const BetterSqlite = require(require.resolve('better-sqlite3', { paths: [FREAPI_DIR] }));
  return new BetterSqlite(DB_PATH);
}

function markVision(db, id) {
  if (id.includes('/')) {
    const [platform, ...rest] = id.split('/');
    db.prepare('UPDATE models SET supports_vision = 1 WHERE platform = ? AND model_id = ?').run(platform, rest.join('/'));
  } else if (id.includes(':')) {
    const [platform, ...rest] = id.split(':');
    db.prepare('UPDATE models SET supports_vision = 1 WHERE platform = ? AND model_id = ?').run(platform, rest.join(':'));
  } else {
    db.prepare('UPDATE models SET supports_vision = 1 WHERE model_id = ?').run(id);
  }
}

async function main() {
  const cfg = readConfig();
  const key = unifiedKey();
  if (!key) throw new Error('尚未生成统一密钥，请先启动一次服务：node bootstrap/control.mjs start');

  const data = await httpJson(`http://127.0.0.1:${cfg.apiPort}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const ids = (data?.data ?? []).map(m => m.id).filter(id => id && !/^my-/i.test(id));
  if (ids.length === 0) throw new Error('模型列表为空：请先在管理页添加免费渠道并填入密钥，再执行本命令');

  const visionRe = /(kimi-k2\.5|multimodal|vision|image|gpt-4o|gemini.*flash)/i;
  const fastRe = /(qfmodel|flash|kimi|glm|minimax|deepseek|qwen)/i;
  const vision = ids.filter(id => visionRe.test(id)).slice(0, 2);
  const text = ids.filter(id => !vision.includes(id) && fastRe.test(id)).slice(0, 8);
  const picked = [...text, ...vision];
  if (picked.length === 0) picked.push(...ids.slice(0, 6));

  const db = writableDb();
  try {
    const raw = readSetting('model_unify_overrides');
    const overrides = raw ? JSON.parse(raw) : { merges: [], splits: [] };
    overrides.merges = (overrides.merges ?? []).filter(m => m.into !== 'my-group');
    overrides.merges.push({
      into: 'my-group',
      keys: picked,
      explicitKey: 'my-group',
      userDefined: true,
    });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('model_unify_overrides', ?)")
      .run(JSON.stringify(overrides));
    for (const id of vision) markVision(db, id);
  } finally { db.close(); }

  console.log('\n✓ 已创建 my-group 单入口：');
  console.log(`  文本/快模型 (${text.length})：${text.join(', ') || '（无，使用列表前几个）'}`);
  console.log(`  视觉模型 (${vision.length})：${vision.join(', ') || '（当前渠道无视觉模型）'}`);
  console.log('\n调用方式：model 填 my-group；带图片时会自动走视觉成员。');
  console.log('如成员不合适，可在管理页调整模型，或编辑后重新执行本命令覆盖。\n');
}

main().catch((error) => { console.error(`\n✗ ${error.message}\n`); process.exit(1); });
