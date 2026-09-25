#!/usr/bin/env node
'use strict';

/*
 * 回合评审状态标记 —— git 门(bash-gate)的配套脚本,兼作 diff 指纹的单一事实源模块。
 *
 * AI 用 ocr delegate 完成一轮评审后运行 `node scripts/review-mark.js done`:
 * 脚本自算当前 diff 指纹写入 .tools/hook-state/ocr-review.json,git 门在
 * commit/push 时重算指纹比对,缺失/不匹配即阻断——防遗忘偷懒,不防伪造
 * (与整个门禁体系同一信任模型:模板防惰性,不防对抗)。
 *
 * 指纹(computeFingerprint,hook-runner.js 的 git 门 require 复用,勿在他处重写):
 *   md5( git status --porcelain -uall 行集
 *      + git diff --ignore-all-space HEAD patch
 *      + 每个 ?? 未跟踪文件空白归一化文本的 md5 )。
 * status 只见路径级变化,diff HEAD 只见已跟踪文件的内容变化——未跟踪文件的
 * 纯内容修改对两者皆盲,第三项逐文件哈希补上:评审后只改内容同样使指纹漂移。
 * 语义化(空白不敏感):Stop 层 GJF 回合末自动格式化不得作废指纹,语义改动仍必须拦截——
 * diff 用 --ignore-all-space 并过滤 index/hunk 头/纯空白增删行,未跟踪哈希按 \s+ 收敛为单空格后取文本。
 * 含 .tools/ 的行剔除:ocr-review.json 落盘前后指纹必须等价,否则标记自噬。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 与 hook-runner.js 相同的根定位:宿主环境变量优先,缺省回退脚本自身定位
const ROOT = process.env.ZCODE_PROJECT_DIR
  || process.env.CLAUDE_PROJECT_DIR
  || path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.tools', 'hook-state', 'ocr-review.json');

function main() {
  const sub = process.argv[2];
  if (sub === 'done') return markDone();
  if (sub === 'status') return printStatus();
  console.error(`用法: node scripts/review-mark.js <done|status>${sub ? `(未知子命令 "${sub}")` : '(缺少子命令)'}`);
  return 1;
}

// done:算指纹写标记。失败留痕 + 非零退出(调用方能感知),不抛栈不崩。
function markDone() {
  let fingerprint;
  try {
    fingerprint = computeFingerprint(ROOT);
  } catch (e) {
    console.error(`[review-mark] 无法计算 diff 指纹(${e.message}),未写入标记`);
    return 1;
  }
  const payload = { version: 1, fingerprint, markedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2) + '\n');
  } catch (e) {
    console.error(`[review-mark] 标记写入失败: ${e.message}`);
    return 1;
  }
  console.log(JSON.stringify(payload));
  // stdout 保持单个可解析 JSON(供工具消费),自证提醒走 stderr
  console.error('[review-mark] 此为自证标记,请确认已按评审流程完成评审与修复');
  return 0;
}

// status:打印标记 JSON(供人/agent 查询);文件不存在或损坏 → {"missing":true}
function printStatus() {
  let payload = { missing: true };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const mark = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (mark && typeof mark.fingerprint === 'string') payload = mark;
    }
  } catch (e) {
    console.error(`[review-mark] 状态文件解析失败(按 missing 处理): ${e.message}`);
  }
  console.log(JSON.stringify(payload));
  return 0;
}

// ---------------------------------------------------------------- 指纹(单一事实源)

// 计算 root 工作区的 diff 指纹并返回 32 位 hex;git 不可用/无提交/读文件失败抛错,由调用方留痕。
// 三处来源在一次调用内算齐,保证标记与校验两侧对同一工作区状态得出同一结果。
function computeFingerprint(root) {
  const status = run('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], { cwd: root, timeoutMs: 15000 });
  if (status.status !== 0) throw new Error(`git status 失败 exit=${status.status}`);
  // 剔除 hook 自身状态目录:.tools/ 下的 ocr-review.json 等落盘不得影响指纹
  const lines = (status.stdout || '')
    .replace(/\r?\n/g, '\n').split('\n').filter(Boolean)
    .filter(l => !l.slice(3).trim().replace(/^"|"$/g, '').startsWith('.tools/'));
  const diff = run('git', ['diff', '--ignore-all-space', 'HEAD'], { cwd: root, timeoutMs: 30000 });
  if (diff.status !== 0) throw new Error(`git diff HEAD 失败 exit=${diff.status}`);
  const hash = crypto.createHash('md5');
  hash.update(lines.join('\n') + '\u0000');
  // -w 只压制行内空白差异,index blob 行/hunk 头/纯空白增删行/相似度行仍随格式化漂移,一并剔除
  // ——已脏跟踪文件的纯格式化改写(GJF 回合末自动格式化)不改变指纹,语义增删行保留
  const patch = (diff.stdout || '')
    .replace(/\r?\n/g, '\n').split('\n')
    .filter(l => !/^index /.test(l) && !/^@@/.test(l) && !/^similarity index /.test(l) && !/^[+-]\s*$/.test(l))
    .join('\n');
  hash.update(patch + '\u0000');
  // 未跟踪文件不进 git diff HEAD:逐文件哈希补"仅改内容"盲区;空白归一化(\s+ 收敛为单空格)
  // 使纯格式化改动(缩进/空行)不改变哈希——GJF 回合末自动格式化不得作废指纹
  for (const line of lines) {
    if (!line.startsWith('?? ')) continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    const normalized = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\s+/g, ' ').trim();
    hash.update(rel + '\u0000' + crypto.createHash('md5').update(normalized).digest('hex') + '\u0000');
  }
  return hash.digest('hex');
}

function run(cmd, args, opts = {}) {
  const viaCmd = process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd);
  return spawnSync(viaCmd ? 'cmd.exe' : cmd, viaCmd ? ['/c', cmd, ...args] : args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    cwd: opts.cwd || ROOT,
    windowsHide: true,
  });
}

if (require.main === module) process.exit(main());
module.exports = { computeFingerprint };
