#!/usr/bin/env node
/**
 * dsh 模型组管理工具（#dsh-integration）
 *
 * 用法（在 freellmapi 目录下）：
 *   node tools/manage-group.mjs list
 *   node tools/manage-group.mjs create <组名> <model1> <model2> ...
 *   node tools/manage-group.mjs add <组名> <model> [model...]      # 往已有组加成员
 *   node tools/manage-group.mjs remove <组名> <model> [model...]   # 从组删成员
 *   node tools/manage-group.mjs delete <组名>
 *   node tools/manage-group.mjs show <组名>
 *
 * 模型名就是 freellmapi /v1/models 里出现的 id（如 deepseek-v4.1-flash-free、
 * kilo-auto/free、trae/glm-5.3 …）。建好的组直接用组名作为 model 调用：
 *   curl http://127.0.0.1:3001/v1/chat/completions \
 *     -H "Authorization: Bearer <unified-key>" -H "Content-Type: application/json" \
 *     -d '{"model":"my-group","messages":[{"role":"user","content":"hi"}]}'
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DB_DIR = join(__dirname, '..', 'server', 'data', 'freeapi.db');

function db() {
  // 直接 require better-sqlite3（与 freellmapi 服务同库）
  const mod = require(join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
  return new mod(DB_DIR);
}

function readOverrides() {
  const d = db();
  try {
    const row = d.prepare("SELECT value FROM settings WHERE key='model_unify_overrides'").get();
    return row ? JSON.parse(row.value) : { merges: [], splits: [] };
  } finally { d.close(); }
}

function writeOverrides(ov) {
  const d = db();
  try {
    d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('model_unify_overrides', ?)")
      .run(JSON.stringify(ov));
  } finally { d.close(); }
}

function findGroup(ov, name) {
  return ov.merges.find(m => m.into === name)
    ?? ov.merges.find(m => m.into.toLowerCase() === name.toLowerCase());
}

const [,, cmd, ...args] = process.argv;

async function main() {
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`dsh 模型组管理工具

命令：
  list                                  列出所有组
  show <组名>                           查看组内成员
  create <组名> <model...>              新建组（至少 1 个模型）
  add <组名> <model...>                 往已有组加成员
  remove <组名> <model...>              从组移除成员
  delete <组名>                         删除整个组

模型 id 用 /v1/models 里的（如 deepseek-v4.1-flash-free / kilo-auto/free / trae/glm-5.3）。
创建后可这样调用组：curl -d '{"model":"<组名>", ...}' http://127.0.0.1:3001/v1/chat/completions`);
    return;
  }

  const ov = readOverrides();

  if (cmd === 'list') {
    if (ov.merges.length === 0) { console.log('（暂无自定义组）'); return; }
    for (const m of ov.merges) console.log(`- ${m.into} (${m.keys.length} 个模型)`);
    return;
  }

  if (cmd === 'show') {
    const g = findGroup(ov, args[0] ?? '');
    if (!g) { console.log(`组 "${args[0]}" 不存在`); process.exit(1); }
    console.log(`组 ${g.into}:`);
    for (const k of g.keys) console.log(`  · ${k}`);
    return;
  }

  if (cmd === 'create') {
    const [name, ...keys] = args;
    if (!name || keys.length === 0) { console.log('用法: create <组名> <model...>'); process.exit(1); }
    if (findGroup(ov, name)) { console.log(`组 "${name}" 已存在`); process.exit(1); }
    ov.merges.push({ into: name, keys });
    writeOverrides(ov);
    console.log(`✓ 已创建组 "${name}"，加入 ${keys.length} 个模型：`);
    for (const k of keys) console.log(`  · ${k}`);
    console.log('刷新 /v1/models 后可用组名直接调用。');
    return;
  }

  if (cmd === 'add') {
    const [name, ...keys] = args;
    const g = findGroup(ov, name);
    if (!g) { console.log(`组 "${name}" 不存在（先 create）`); process.exit(1); }
    let added = 0;
    // 模型 id 自动加 platform 前缀（dsh 平台的简写）
    for (const k of keys) {
      const full = k.includes(':') ? k : `dsh:${k}`;
      if (!g.keys.includes(full)) { g.keys.push(full); added++; }
    }
    writeOverrides(ov);
    console.log(`✓ 已往 "${name}" 加入 ${added} 个模型，现共 ${g.keys.length} 个。`);
    return;
  }

  if (cmd === 'remove') {
    const [name, ...keys] = args;
    const g = findGroup(ov, name);
    if (!g) { console.log(`组 "${name}" 不存在`); process.exit(1); }
    let removed = 0;
    for (const k of keys) {
      const full = k.includes(':') ? k : `dsh:${k}`;
      const i = g.keys.indexOf(full);
      if (i >= 0) { g.keys.splice(i, 1); removed++; }
    }
    if (g.keys.length === 0) ov.merges = ov.merges.filter(m => m !== g);
    writeOverrides(ov);
    console.log(`✓ 已从 "${name}" 移除 ${removed} 个模型${g.keys.length === 0 ? '（组已空，自动删除）' : `，剩 ${g.keys.length} 个`}。`);
    return;
  }

  if (cmd === 'delete') {
    const name = args[0] ?? '';
    const before = ov.merges.length;
    ov.merges = ov.merges.filter(m => m.into !== name && m.into.toLowerCase() !== name.toLowerCase());
    writeOverrides(ov);
    console.log(before === ov.merges.length ? `组 "${name}" 不存在` : `✓ 已删除组 "${name}"。`);
    return;
  }

  console.log(`未知命令: ${cmd}（试试 help）`);
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });