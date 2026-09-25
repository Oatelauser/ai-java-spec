#!/usr/bin/env node
'use strict';

/*
 * 依赖版本查新与整批升级(自包含,模板侧与目标项目侧通用):
 *
 *   node scripts/upgrade.js --check   # 只读:ocr / google-java-format / SpotBugs 版本对比表;
 *                                     #   存在"最新 > 锚点(baseline 或 hook-config 配置版本)或 > 本机"
 *                                     #   时 exit 1 并列出建议动作(CI 据此开 issue 提醒)
 *   node scripts/upgrade.js           # 执行:升 ocr(npm 全局)→ 重生成 rule.json → selftest 回归
 *                                     #   → ocr delegate preview 冒烟;任一步失败醒目输出回退命令并 exit 1
 *
 * cwd 自适应(仅影响提示语里的命令前缀):cwd 下有 resources/scripts/hook-config.json = 模板仓,
 *   否则按 scripts/hook-config.json = 目标项目根。子进程一律按 __dirname 定位同目录脚本,不依赖 cwd。
 *
 * 容错:每项网络查询独立失败独立标注("查询失败"),不阻塞其它项、不影响退出码——查不到 ≠ 有新版。
 * 注意:shell:true 仅为 Windows 解析 npm/ocr 的 .cmd(spawn 默认不查 PATHEXT);参数全部静态,无注入面。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const CONFIG = path.join(SCRIPTS_DIR, 'hook-config.json');
const OCR_PKG = '@alibaba-group/open-code-review';
const IS_TEMPLATE_REPO = fs.existsSync(path.join(process.cwd(), 'resources', 'scripts', 'hook-config.json'));
const PREFIX = IS_TEMPLATE_REPO ? 'resources/scripts/' : 'scripts/';

main().catch(e => {
  console.error(`[upgrade] 失败: ${e.message}`);
  process.exit(1);
});

async function main() {
  if (!fs.existsSync(CONFIG)) throw new Error(`未找到 hook-config.json(期望在 ${CONFIG})`);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (process.argv.includes('--check')) {
    await checkMode(cfg);
  } else {
    await upgradeMode(cfg);
  }
}

/* ---------------- 只读对比 ---------------- */

async function checkMode(cfg) {
  console.log(`[upgrade] 依赖版本对比(视角:${IS_TEMPLATE_REPO ? '模板仓' : '目标项目根'};命令前缀 ${PREFIX})`);
  const rows = [];
  const actions = [];

  // ① ocr:npm 最新 vs 本机 ocr vs baseline(hook-config.ocr.baseline = 实测回归通过的锚点)
  const ocrBaseline = cfg.ocr && cfg.ocr.baseline;
  const ocrLocal = localOcrVersion();
  const ocrLatest = npmLatest(OCR_PKG);
  rows.push(['ocr(open-code-review)', ocrBaseline || '未配置', ocrLocal || '未安装', ocrLatest || '查询失败']);
  if (ocrLatest && ocrBaseline && cmpVer(ocrLatest, ocrBaseline) > 0) {
    rows[rows.length - 1].push('落后');
    actions.push(`ocr 最新 ${ocrLatest} > baseline ${ocrBaseline}:跑 ${PREFIX}upgrade.js 升级并回归,全绿后更新 hook-config.json 的 ocr.baseline`);
  } else if (ocrLatest && ocrLocal && cmpVer(ocrLatest, ocrLocal) > 0) {
    rows[rows.length - 1].push('本机落后');
    actions.push(`ocr 最新 ${ocrLatest} > 本机 ${ocrLocal}:npm i -g ${OCR_PKG}@latest 后跑 ${PREFIX}selftest.js 回归`);
  } else {
    rows[rows.length - 1].push(judge(ocrLatest, ocrLocal, ocrBaseline));
  }

  // ② google-java-format:GitHub Releases 最新 vs hook-config formatter.version(.tools 按 config 下载,config 即本机)
  const gjfCfg = cfg.formatter && cfg.formatter.version;
  const gjfLatest = await ghLatest('google/google-java-format');
  rows.push(['google-java-format(.tools)', gjfCfg || '未配置', '按配置缓存', gjfLatest || '查询失败']);
  if (gjfLatest && gjfCfg && cmpVer(gjfLatest, gjfCfg) > 0) {
    rows[rows.length - 1].push('落后');
    actions.push(`google-java-format 最新 ${gjfLatest} > 配置 ${gjfCfg}:改 hook-config.json 的 formatter.version 后跑 ${PREFIX}install.js(warmup)下载新版`);
  } else {
    rows[rows.length - 1].push(judge(gjfLatest, gjfCfg));
  }

  // ③ SpotBugs:同法;deepScan 未启用则跳过(版本只在该开关打开时才被用到)
  if (cfg.deepScan && cfg.deepScan.enabled) {
    const sbCfg = cfg.deepScan.spotbugsVersion;
    const sbLatest = await ghLatest('spotbugs/spotbugs');
    rows.push(['SpotBugs(deepScan)', sbCfg || '未配置', '按配置缓存', sbLatest || '查询失败']);
    if (sbLatest && sbCfg && cmpVer(sbLatest, sbCfg) > 0) {
      rows[rows.length - 1].push('落后');
      actions.push(`SpotBugs 最新 ${sbLatest} > 配置 ${sbCfg}:改 hook-config.json 的 deepScan.spotbugsVersion 后重跑 warmup`);
    } else {
      rows[rows.length - 1].push(judge(sbLatest, sbCfg));
    }
  } else {
    rows.push(['SpotBugs(deepScan)', '未启用', '—', '—', '跳过']);
  }

  printTable(rows);
  if (actions.length > 0) {
    console.log('\n[upgrade] 建议动作:');
    actions.forEach(a => console.log(`[upgrade]   - ${a}`));
    process.exit(1);
  }
  console.log('\n[upgrade] 全部为最新(或查询失败项无法判定),无需动作。');
}

// 单项判定:最新查不到=查询失败;本机/锚点缺失=无法比对;否则一致
function judge(latest, ...known) {
  if (!latest) return '查询失败';
  return known.every(k => k) ? '一致' : '无法比对';
}

function printTable(rows) {
  console.log('\n| 工具 | 锚点 | 本机 | 最新 | 判定 |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
}

/* ---------------- 执行升级 ---------------- */

async function upgradeMode(cfg) {
  const baseline = (cfg.ocr && cfg.ocr.baseline) || '';
  const results = [];
  let failed = false;

  // ① 升级 ocr(全局 npm 包):失败不中断——后续步骤仍要跑,标注即可
  console.log(`[upgrade] 步骤 1/4: 升级 ocr(npm i -g ${OCR_PKG}@latest)...`);
  const inst = spawnSync('npm', ['i', '-g', `${OCR_PKG}@latest`], { shell: true, stdio: 'inherit', timeout: 10 * 60 * 1000 });
  if (inst.status !== 0) {
    failed = true;
    results.push(`① ocr 升级失败(exit ${inst.status}${inst.error ? `, ${inst.error.message}` : ''})`);
  } else {
    results.push(`① ocr 升级完成,本机现 ${localOcrVersion() || '版本未识别(ocr --version 无输出)'}`);
  }

  // ② 重生成 rule.json:消灭"源(p3c-rules.md)改了产物没跟"的漂移
  console.log('[upgrade] 步骤 2/4: 重生成 rule.json(build-rules)...');
  const gen = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'build-rules.js')], { stdio: 'inherit' });
  if (gen.status !== 0) {
    failed = true;
    results.push(`② build-rules 失败(exit ${gen.status})`);
  } else {
    results.push('② rule.json 重生成通过');
  }

  // ③ selftest 全量回归(自建自删仓库,耗时数分钟,超时给足)
  console.log('[upgrade] 步骤 3/4: selftest 回归(可能数分钟)...');
  const st = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'selftest.js')], { stdio: 'inherit', timeout: 15 * 60 * 1000 });
  if (st.status !== 0) {
    failed = true;
    results.push(`③ selftest 失败(${st.error && st.error.code === 'ETIMEDOUT' ? '超时' : `exit ${st.status}`})`);
  } else {
    results.push('③ selftest 全绿');
  }

  // ④ preview 冒烟:空范围(--from HEAD --to HEAD)验证 stdout 契约——JSON 可解析、顶层结构字段仍在
  console.log('[upgrade] 步骤 4/4: ocr delegate preview 冒烟...');
  const pv = spawnSync('ocr', ['delegate', 'preview', '--format', 'json', '--from', 'HEAD', '--to', 'HEAD'], { shell: true, encoding: 'utf8', timeout: 2 * 60 * 1000 });
  const head = ((pv.stdout || '') + (pv.stderr || '')).trim().split(/\r?\n/).slice(0, 5).join('\n');
  console.log(`[upgrade] preview 输出前 5 行:\n${head || '(无输出)'}`);
  let smokeOk = pv.status === 0 && !!pv.stdout;
  if (smokeOk) {
    try {
      const j = JSON.parse(pv.stdout);
      smokeOk = typeof j === 'object' && j !== null && 'schema_version' in j;
    } catch {
      smokeOk = false;
    }
  }
  if (!smokeOk) {
    failed = true;
    results.push(`④ preview 冒烟失败(${pv.error ? pv.error.message : `exit ${pv.status}`};须为可解析 JSON 且含 schema_version 顶层字段)`);
  } else {
    results.push('④ preview 冒烟通过(JSON 可解析,顶层结构字段在)');
  }

  console.log('\n[upgrade] ===== 汇总 =====');
  results.forEach(r => console.log(`[upgrade] ${r}`));
  if (failed) {
    console.error('\n[upgrade] !!! 有步骤失败,按需回退:');
    console.error(`[upgrade]   npm i -g ${OCR_PKG}${baseline ? `@${baseline}` : '@<原版本>'}`);
    console.error('[upgrade] 回退后重跑 selftest 确认,并在仓库记 issue 留痕。');
    process.exit(1);
  }
  const now = localOcrVersion();
  console.log(`\n[upgrade] 全部通过。记得把 hook-config.json 的 ocr.baseline 更新为 ${now || '本机新版本'}(baseline=实测回归通过的版本),再重新传导各项目。`);
}

/* ---------------- 探测工具(全部容错,失败返回 null) ---------------- */

// npm registry 最新版;取输出最后一行(规避 npm 前置的告警行)
function npmLatest(pkg) {
  const r = spawnSync('npm', ['view', pkg, 'version'], { shell: true, encoding: 'utf8', timeout: 60 * 1000 });
  if (r.status !== 0 || !r.stdout || !r.stdout.trim()) return null;
  const last = r.stdout.trim().split(/\r?\n/).pop().trim();
  return /^\d+\.\d+\.\d+/.test(last) ? last : null;
}

// 本机全局 ocr 版本(输出形如 "open-code-review v1.12.9 (hash) ...");未装/超时返回 null
function localOcrVersion() {
  const r = spawnSync('ocr', ['--version'], { shell: true, encoding: 'utf8', timeout: 30 * 1000 });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.match(/v(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

// GitHub Releases 最新 tag(去 v 前缀);网络失败/限流返回 null,绝不抛出
function ghLatest(repo) {
  return new Promise(resolve => {
    const req = https.get(
      { host: 'api.github.com', path: `/repos/${repo}/releases/latest`, headers: { 'User-Agent': 'quality-hook-upgrade-check' }, timeout: 15 * 1000 },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try {
            resolve(String(JSON.parse(body).tag_name || '').replace(/^v/, '') || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// 语义化版本比较:-1/0/1;容忍 v 前缀与缺失段(1.36 == 1.36.0)
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
