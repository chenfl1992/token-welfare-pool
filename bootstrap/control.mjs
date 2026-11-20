#!/usr/bin/env node
// 服务控制与跨平台开机自启：start | stop | status | install-autostart | uninstall-autostart
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  GENERATED_DIR, FREAPI_DIR, OFM_DIR, readConfig,
  ensureGenerated, portOpen, sleep,
} from './lib.mjs';

const command = process.argv[2] || 'status';
const cfg = readConfig();

function services() {
  const list = [{
    name: 'freellmapi',
    cwd: FREAPI_DIR,
    script: 'server/dist/index.js',
    args: [],
    port: cfg.apiPort,
  }];
  if (cfg.ofmEnabled) {
    list.push({
      name: 'ofm',
      cwd: OFM_DIR,
      script: 'packages/standalone/cli.mjs',
      args: ['--port', String(cfg.ofmPort), '--data-dir', cfg.ofmDataDir],
      port: cfg.ofmPort,
    });
  }
  return list;
}

function tunnelService() {
  if (!cfg.tunnelMode || cfg.tunnelMode === 'off') return null;
  const cwd = GENERATED_DIR;
  const args = cfg.tunnelMode === 'named'
    ? ['tunnel', '--config', cfg.tunnelConfig, 'run', cfg.tunnelName]
    : ['tunnel', '--url', `http://127.0.0.1:${cfg.apiPort}`];
  return { name: 'tunnel', cwd, script: '', args, port: null, binary: which('cloudflared') };
}

function which(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [name], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null;
}

function pidFile(name) { return path.join(GENERATED_DIR, `${name}.pid`); }
function logFile(name) { return path.join(GENERATED_DIR, `${name}.log`); }

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function startOne(svc) {
  if (svc.port != null && await portOpen(svc.port)) {
    console.log(`  ✓ ${svc.name}: 端口 ${svc.port} 已在监听`);
    return;
  }
  const gen = ensureGenerated();
  const log = logFile(svc.name);
  const out = fs.openSync(log, 'a');
  const binary = svc.binary || process.execPath;
  const scriptArgs = svc.script ? [path.join(svc.cwd, svc.script), ...svc.args] : svc.args;
  const child = spawn(binary, scriptArgs, {
    cwd: svc.cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(pidFile(svc.name), String(child.pid));
  if (svc.port == null) {
    await sleep(1500);
    console.log(`  ✓ ${svc.name}: 已启动 (pid ${child.pid})`);
    return;
  }
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await portOpen(svc.port)) {
      console.log(`  ✓ ${svc.name}: 已启动 (pid ${child.pid}, 端口 ${svc.port})`);
      return;
    }
  }
  console.warn(`  ⚠ ${svc.name}: 启动超时，日志：${log}（${gen}）`);
}

function stopOne(svc) {
  const file = pidFile(svc.name);
  if (!fs.existsSync(file)) return console.log(`  · ${svc.name}: 无 pid 记录`);
  const pid = fs.readFileSync(file, 'utf8').trim();
  if (!alive(pid)) { fs.unlinkSync(file); return console.log(`  · ${svc.name}: 进程已退出`); }
  try { process.kill(Number(pid), 'SIGTERM'); console.log(`  ✓ ${svc.name}: 已停止 (pid ${pid})`); }
  catch (error) { console.warn(`  ⚠ ${svc.name}: 停止失败 ${error.message}`); }
  fs.unlinkSync(file);
}

async function status() {
  console.log('\n服务状态：');
  for (const svc of services()) {
    const up = await portOpen(svc.port);
    console.log(`  ${up ? '● 运行中' : '○ 未运行'}  ${svc.name}  127.0.0.1:${svc.port}`);
  }
  const tunnel = tunnelService();
  if (tunnel) console.log(`  ${tunnel.binary ? '● 已安装 cloudflared' : '○ 未找到 cloudflared'}  公网隧道模式：${cfg.tunnelMode}`);
  if (cfg.publicUrl) console.log(`  公网地址：${cfg.publicUrl}`);
  console.log('');
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plist(label, svc) {
  const binary = svc.binary || cfg.nodeBin;
  const parts = svc.script ? [path.join(svc.cwd, svc.script), ...svc.args] : svc.args;
  const program = [binary, ...parts].map(p => `        <string>${escapeXml(p)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${program}
    </array>
    <key>WorkingDirectory</key><string>${escapeXml(svc.cwd)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${escapeXml(logFile(svc.name))}</string>
    <key>StandardErrorPath</key><string>${escapeXml(logFile(svc.name))}</string>
</dict>
</plist>
`;
}

function systemdUnit(svc) {
  const binary = svc.binary || cfg.nodeBin;
  const parts = svc.script ? [path.join(svc.cwd, svc.script), ...svc.args] : svc.args;
  const exec = [binary, ...parts].map(p => `"${p}"`).join(' ');
  return `[Unit]
Description=Token Welfare Pool - ${svc.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${svc.cwd}
ExecStart=${exec}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function windowsCmd(svc) {
  const binary = svc.binary || cfg.nodeBin;
  const parts = svc.script ? [path.join(svc.cwd, svc.script), ...svc.args] : svc.args;
  const line = [binary, ...parts].map(p => `"${p}"`).join(' ');
  return `@echo off\r\ncd /d "${svc.cwd}"\r\n${line}\r\n`;
}

function allServices() {
  const list = services();
  const tunnel = tunnelService();
  if (tunnel) {
    if (!tunnel.binary) {
      console.warn('  ⚠ 未找到 cloudflared，跳过隧道自启。安装后重新执行 install-autostart。');
    } else list.push(tunnel);
  }
  return list;
}

function installAutostart() {
  if (!cfg.autostart) { console.log('  配置中已关闭开机自启，跳过。'); return; }
  const list = allServices();
  console.log(`\n注册开机自启（${process.platform}）：`);

  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    for (const svc of list) {
      const label = `com.tokenpool.${svc.name}`;
      const file = path.join(dir, `${label}.plist`);
      fs.writeFileSync(file, plist(label, svc));
      const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
      const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, file], { encoding: 'utf8' });
      console.log(`  ✓ ${file}${r.status === 0 ? '（已立即加载）' : '（下次登录后自动加载）'}`);
    }
  } else if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    for (const svc of list) {
      const file = path.join(dir, `tokenpool-${svc.name}.service`);
      fs.writeFileSync(file, systemdUnit(svc));
      spawnSync('systemctl', ['--user', 'daemon-reload']);
      const r = spawnSync('systemctl', ['--user', 'enable', '--now', `tokenpool-${svc.name}.service`], { encoding: 'utf8' });
      console.log(`  ✓ ${file}${r.status === 0 ? '（已启用）' : '（执行失败：' + (r.stderr || '').trim().slice(0, 120) + '）'}`);
    }
  } else if (process.platform === 'win32') {
    ensureGenerated();
    for (const svc of list) {
      const cmdFile = path.join(GENERATED_DIR, `start-${svc.name}.cmd`);
      fs.writeFileSync(cmdFile, windowsCmd(svc));
      const name = `TokenPool-${svc.name}`;
      const r = spawnSync('schtasks', ['/Create', '/TN', name, '/TR', `"${cmdFile}"`, '/SC', 'ONLOGON', '/F'], { encoding: 'utf8' });
      console.log(`  ${r.status === 0 ? '✓' : '⚠'} ${name}: ${(r.stdout || r.stderr || '').trim().slice(0, 160)}`);
      console.log(`    启动脚本：${cmdFile}`);
    }
  } else {
    console.log('  ⚠ 未识别的平台，请按 docs/安装指南.md 手动配置自启。');
  }
}

function uninstallAutostart() {
  const names = services().map(s => s.name);
  const tunnel = tunnelService();
  if (tunnel) names.push('tunnel');
  console.log('\n移除开机自启：');
  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    for (const name of names) {
      const label = `com.tokenpool.${name}`;
      const file = path.join(dir, `${label}.plist`);
      spawnSync('launchctl', ['bootout', `gui/${spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()}`, file]);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      console.log(`  ✓ ${label} 已移除`);
    }
  } else if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user');
    for (const name of names) {
      spawnSync('systemctl', ['--user', 'disable', '--now', `tokenpool-${name}.service`]);
      const file = path.join(dir, `tokenpool-${name}.service`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      console.log(`  ✓ tokenpool-${name} 已移除`);
    }
  } else if (process.platform === 'win32') {
    for (const name of names) {
      spawnSync('schtasks', ['/Delete', '/TN', `TokenPool-${name}`, '/F']);
      console.log(`  ✓ TokenPool-${name} 已移除`);
    }
  }
}

async function main() {
  switch (command) {
    case 'start':
      console.log('\n启动服务：');
      for (const svc of services()) await startOne(svc);
      const tunnel = tunnelService();
      if (tunnel) {
        if (tunnel.binary) await startOne(tunnel);
        else console.warn('  ⚠ 未找到 cloudflared，公网隧道未启动。');
      }
      console.log('');
      break;
    case 'stop':
      console.log('\n停止服务：');
      for (const svc of services()) stopOne(svc);
      console.log('');
      break;
    case 'status': await status(); break;
    case 'install-autostart': installAutostart(); break;
    case 'uninstall-autostart': uninstallAutostart(); break;
    default:
      console.log('用法: node bootstrap/control.mjs <start|stop|status|install-autostart|uninstall-autostart>');
      process.exit(1);
  }
}

main().catch((error) => { console.error(`\n✗ ${error.message}\n`); process.exit(1); });
