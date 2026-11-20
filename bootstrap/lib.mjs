// 共用工具：路径、配置读写、HTTP 与进程探测。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'config', 'deployment.json');
export const GENERATED_DIR = path.join(ROOT, 'config', 'generated');
export const FREAPI_DIR = path.join(ROOT, 'apps', 'freellmapi');
export const OFM_DIR = path.join(ROOT, 'apps', 'ofm-gateway');
export const DB_PATH = path.join(FREAPI_DIR, 'server', 'data', 'freeapi.db');

export function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('缺少 config/deployment.json，请先执行：node bootstrap/setup.mjs');
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

export function ensureGenerated() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  return GENERATED_DIR;
}

export async function httpJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), ...options });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
    throw new Error(`HTTP ${response.status} ${url} ${detail}`);
  }
  return body;
}

export function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port: Number(port), host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1200);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只读读取 settings 表：复用服务端依赖，避免重复安装。 */
export function readSetting(key) {
  if (!fs.existsSync(DB_PATH)) return null;
  try {
    const BetterSqlite = require(require.resolve('better-sqlite3', { paths: [FREAPI_DIR] }));
    const db = new BetterSqlite(DB_PATH, { readonly: true });
    try {
      return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
    } finally { db.close(); }
  } catch { return null; }
}

export function unifiedKey() {
  return readSetting('unified_api_key');
}

