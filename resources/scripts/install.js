#!/usr/bin/env node
'use strict';

/*
 * resources 资产安装器 —— 兜底通道。
 * 正常情况不需要本脚本:直接把 resources/ 里的全部文件和文件夹(含隐藏的 .zcode/)
 * 拷贝到目标项目根目录即完整可用。仅当缺件、或想一条命令自动补齐时使用。
 *
 * 用法:
 *   node <模板>/resources/scripts/install.js <目标项目根>
 *
 * 只依赖 node 与文件系统;合并覆盖,不删除目标已有文件。install.js 自身不会拷入目标
 * (因此它只存在于模板侧,拷贝出的项目里没有它,重装/补齐都回模板来跑)。
 * 安全阀(缺一即拒绝执行):
 *   1. 上级目录必须带有资产标记(.zcode/config.json + scripts/hook-runner.js),
 *      防止"把 install.js 单独拷到别处运行"时把它所在的无关目录整个装进目标;
 *   2. 目标目录不得包含资产根(防止把资产装回模板根,覆盖指针文件)。
 * 注意:刻意不用 fs.cpSync —— node 25 实测其在中文路径下原生崩溃(静默退出),
 *      copyFileSync 同场景正常,故手写递归拷贝。
 */

const fs = require('fs');
const path = require('path');

const ASSETS_ROOT = path.resolve(__dirname, '..'); // resources/
const SELF = path.resolve(__filename);             // 本文件,拷贝时排除
const MARKERS = ['.zcode/config.json', 'scripts/hook-runner.js'];

try {
  main();
} catch (e) {
  console.error(`[install] 失败: ${e.message}`);
  process.exit(1);
}

function main() {
  assertAssetsComplete();
  const target = path.resolve(process.argv[2] || process.cwd());
  assertTargetOutsideAssets(target);
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(ASSETS_ROOT, { withFileTypes: true })) {
    if (entry.name === '.tools') continue;
    copyTree(path.join(ASSETS_ROOT, entry.name), path.join(target, entry.name));
    console.log(`[install] 已安装: ${entry.name}${entry.isDirectory() ? '/' : ''}`);
  }
  ensureGitignore(target);
  console.log(`[install] 完成: ${target}`);
  console.log('[install] 下一步: 重开 ZCode 会话(加载 hook)后写一个违规 .java 验证;可选预热: node scripts/hook-runner.js warmup');
}

function assertAssetsComplete() {
  const missing = MARKERS.filter(m => !fs.existsSync(path.join(ASSETS_ROOT, m)));
  if (missing.length > 0) {
    throw new Error(`本脚本上级目录不是完整的 resources 资产(缺 ${missing.join('、')});请从模板的 resources/scripts/ 运行`);
  }
}

function assertTargetOutsideAssets(target) {
  const rel = path.relative(target, ASSETS_ROOT);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('目标目录包含 resources/ 自身(疑似模板根),拒绝安装');
  }
}

function copyTree(from, to) {
  if (path.resolve(from) === SELF) return; // 安装器不随资产下发
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
  } else {
    fs.copyFileSync(from, to);
  }
}

function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/).includes('.tools/')) return;
  fs.appendFileSync(file, `${fs.existsSync(file) ? '\n' : ''}# quality-hook 工具下载缓存\n.tools/\n`);
}
