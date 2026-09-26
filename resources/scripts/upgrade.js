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
 *   node scripts/upgrade.js --pack <目录>
 *                                     # 打离线升级包(模板仓 CI 在 --check exit 1 后调用):只收落后项——
 *                                     #   ocr 主包+平台包 tgz(原生二进制由平台包携带,postinstall 见之
 *                                     #   即不触网)、google-java-format jar、SpotBugs tgz(仅 deepScan
 *                                     #   启用);manifest.json 记版本与 sha256
 *   node scripts/upgrade.js --offline <目录>
 *                                     # 零网络应用离线包:sha256 校验 → ocr 本地 tgz 安装 + jar/tgz 落位
 *                                     #   .tools/(官方文件名即 warmup 的免改名识别通道,见文件即跳过下载);
 *                                     #   不自动跑回归、不自动改 baseline,收尾打印下一步
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
const crypto = require('crypto');
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
  const offlineDir = argAfter('--offline');
  const packDir = argAfter('--pack');
  if (offlineDir !== undefined) {
    await offlineMode(cfg, offlineDir);
  } else if (packDir !== undefined) {
    await packMode(cfg, packDir);
  } else if (process.argv.includes('--check')) {
    await checkMode(cfg);
  } else {
    await upgradeMode(cfg);
  }
}

// 取 flag 后面的参数;flag 出现但缺参 → null(与"未出现"的 undefined 区分,便于各自报准确错误)
function argAfter(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1] || null;
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

/* ---------------- 打离线升级包(CI 在 --check exit 1 后调用) ---------------- */

// URL 候选与 hook-runner.js 的 gjfDownloadUrls/ensureSpotBugs 同源同构:只是这里下载"最新版"
// 而 warmup 下载"配置版";hook-runner 改候选地址时此处需同步
function gjfUrls(v) {
  return [
    `https://repo1.maven.org/maven2/com/google/googlejavaformat/google-java-format/${v}/google-java-format-${v}-all-deps.jar`,
    `https://github.com/google/google-java-format/releases/download/v${v}/google-java-format-${v}-all-deps.jar`,
  ];
}

function spotbugsUrls(v) {
  return [
    `https://github.com/spotbugs/spotbugs/releases/download/${v}/spotbugs-${v}.tgz`,
    `https://repo1.maven.org/maven2/com/github/spotbugs/spotbugs/${v}/spotbugs-${v}.tgz`,
  ];
}

async function packMode(cfg, dir) {
  if (!dir) throw new Error('--pack 需要目标目录参数,如: node scripts/upgrade.js --pack dep-bundle');
  fs.mkdirSync(dir, { recursive: true });
  const items = [];

  // ① ocr:主包 + 平台包两个 tgz。原生二进制不进主包,由 optionalDependencies 的
  //    平台包携带(@alibaba-group/ocr-<os>-<arch>);postinstall 检测到平台包提供的二进制
  //    即跳过网络下载,两个 tgz 一起 npm i -g 就是真离线安装。只打消费端平台(维护者为
  //    Windows x64;要覆盖其它机器时给 OCR_PLATFORM 换/加平台各打一份即可)
  const OCR_PLATFORM = 'ocr-win32-x64';
  const ocrAnchor = cfg.ocr && cfg.ocr.baseline;
  const ocrLatest = npmLatest(OCR_PKG);
  if (ocrLatest && ocrAnchor && cmpVer(ocrLatest, ocrAnchor) > 0) {
    console.log(`[pack] ocr ${ocrAnchor} → ${ocrLatest},npm pack(主包 + ${OCR_PLATFORM})...`);
    for (const pkg of [OCR_PKG, `@alibaba-group/${OCR_PLATFORM}`]) {
      const inst = spawnSync('npm', ['pack', `${pkg}@${ocrLatest}`, '--pack-destination', dir], { shell: true, stdio: 'inherit', timeout: 10 * 60 * 1000 });
      if (inst.status !== 0) throw new Error(`ocr npm pack ${pkg} 失败(exit ${inst.status})`);
    }
    const mainTgz = fs.readdirSync(dir).find(f => f.endsWith(`open-code-review-${ocrLatest}.tgz`));
    const platTgz = fs.readdirSync(dir).find(f => f.endsWith(`${OCR_PLATFORM}-${ocrLatest}.tgz`));
    if (!mainTgz || !platTgz) throw new Error(`npm pack 后未在 ${dir} 找齐主包/平台包 tgz(期望 *open-code-review-${ocrLatest}.tgz 与 *${OCR_PLATFORM}-${ocrLatest}.tgz)`);
    items.push(manifestItem('ocr', ocrLatest, path.join(dir, mainTgz), `npm pack ${OCR_PKG}@${ocrLatest}`));
    items.push(manifestItem('ocr-platform', ocrLatest, path.join(dir, platTgz), `npm pack @alibaba-group/${OCR_PLATFORM}@${ocrLatest}`));
  }

  // ② google-java-format:jar,候选序与 warmup 一致(Maven Central 主 / GitHub 备)
  const gjfAnchor = cfg.formatter && cfg.formatter.version;
  const gjfLatest = await ghLatest('google/google-java-format');
  if (gjfLatest && gjfAnchor && cmpVer(gjfLatest, gjfAnchor) > 0) {
    const file = path.join(dir, `google-java-format-${gjfLatest}-all-deps.jar`);
    console.log(`[pack] google-java-format ${gjfAnchor} → ${gjfLatest},下载 jar...`);
    items.push(manifestItem('google-java-format', gjfLatest, file, curlTo(gjfUrls(gjfLatest), file)));
  }

  // ③ SpotBugs:仅 deepScan 启用时才在下载面内(对齐 --check 的跳过逻辑);
  //    findsecbugs 插件 jar 依赖 SpotBugs 解压后的目录结构,不在此打包,仍由 warmup 在线补
  const dsOn = cfg.deepScan && cfg.deepScan.enabled;
  const sbAnchor = dsOn && cfg.deepScan.spotbugsVersion;
  const sbLatest = dsOn ? await ghLatest('spotbugs/spotbugs') : null;
  if (sbLatest && sbAnchor && cmpVer(sbLatest, sbAnchor) > 0) {
    const file = path.join(dir, `spotbugs-${sbLatest}.tgz`);
    console.log(`[pack] SpotBugs ${sbAnchor} → ${sbLatest},下载 tgz...`);
    items.push(manifestItem('spotbugs', sbLatest, file, curlTo(spotbugsUrls(sbLatest), file)));
  }

  if (items.length === 0) {
    console.log('[pack] 无落后项,未产包(全量最新)。');
    return;
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2)}\n`);
  console.log('\n[pack] ===== 离线包内容 =====');
  console.log('| 工具 | 版本 | 文件 | sha256(前 12 位) |');
  console.log('|---|---|---|---|');
  for (const i of items) console.log(`| ${i.name} | ${i.version} | ${i.file} | ${i.sha256.slice(0, 12)}… |`);
  console.log(`[pack] manifest.json 已写入,目录:${path.resolve(dir)}`);
}

// 逐候选下载(curl 系统自带:CI ubuntu 与 Win10+ 均有;curl 是 .exe,无需 shell:true)。
// -f:HTTP 4xx/5xx 不落盘;-L:跟随 GitHub Releases 的重定向;失败清掉半截文件,避免坏包混入
function curlTo(urls, dest) {
  const failures = [];
  for (const url of urls) {
    const r = spawnSync('curl', ['-fL', '--retry', '2', '--connect-timeout', '30', '-o', dest, url], { stdio: 'inherit', timeout: 10 * 60 * 1000 });
    if (r.status === 0) return url;
    failures.push(`${url}(exit ${r.status})`);
    fs.rmSync(dest, { force: true });
  }
  throw new Error(`下载失败,全部候选源未成功:${failures.join(' | ')}`);
}

function manifestItem(name, version, file, source) {
  return { name, version, file: path.basename(file), source, sha256: sha256File(file) };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ---------------- 离线应用(零网络) ---------------- */

async function offlineMode(cfg, dir) {
  if (!dir) throw new Error('--offline 需要离线包解压目录参数(内含 manifest.json 与工具文件)');
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`未找到 ${manifestPath}(应传 artifact 解压后的目录)`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const TOOLS = path.join(SCRIPTS_DIR, '..', '.tools');
  const local = {
    ocr: localOcrVersion() || '',
    'google-java-format': (cfg.formatter && cfg.formatter.version) || '',
    spotbugs: (cfg.deepScan && cfg.deepScan.spotbugsVersion) || '',
  };

  // ① 版本对比(代替独立 --diff 模式):包内 vs 本机/配置锚点
  console.log('| 工具 | 包内版本 | 本机/配置 | 判定 |');
  console.log('|---|---|---|---|');
  for (const i of manifest.items) {
    const anchor = local[i.name] || (i.name === 'ocr-platform' ? local.ocr : '');
    console.log(`| ${i.name} | ${i.version} | ${anchor || '未安装/未配置'} | ${cmpVer(i.version, anchor) > 0 ? '升级' : '持平/降级'} |`);
  }

  // ② 完整性:逐文件 sha256——包经浏览器下载/解压/拷贝搬运,先验坏再动手
  for (const i of manifest.items) {
    const f = path.join(dir, i.file);
    if (!fs.existsSync(f)) throw new Error(`缺文件:${f}`);
    if (sha256File(f) !== i.sha256) throw new Error(`sha256 不符:${i.file}(包损坏或不完整,请重新下载)`);
  }
  console.log('[offline] 完整性校验通过(sha256)。');

  // ③ 应用:ocr 主包+平台包 tgz 一起 npm i -g(postinstall 见平台包二进制即不触网);
  //    jar/tgz 落位 .tools/ 官方文件名(warmup 的免改名识别通道,见文件即跳过下载)
  const ocrFiles = manifest.items.filter(i => i.name === 'ocr' || i.name === 'ocr-platform').map(i => path.join(dir, i.file));
  for (const i of manifest.items) {
    if (i.name === 'ocr-platform') continue; // 与主包同一次 npm i 安装,不单独处理
    const f = path.join(dir, i.file);
    if (i.name !== 'ocr') {
      const rel = i.name === 'spotbugs' ? path.join('spotbugs', i.file) : path.join('google-java-format', i.file);
      const dest = path.join(TOOLS, rel);
      if (fs.existsSync(dest)) {
        console.log(`[offline] 已存在,跳过拷贝:${path.relative(process.cwd(), dest)}`);
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f, dest);
        console.log(`[offline] 落位:${path.relative(process.cwd(), dest)}`);
      }
      continue;
    }
    console.log(`[offline] 安装 ocr ${i.version}(本地 tgz,零网络)...`);
    const inst = spawnSync('npm', ['i', '-g', ...ocrFiles, '--no-audit', '--no-fund'], { shell: true, stdio: 'inherit', timeout: 10 * 60 * 1000 });
    if (inst.status !== 0) throw new Error(`ocr 离线安装失败(exit ${inst.status})`);
    const now = localOcrVersion();
    if (!now || cmpVer(now, i.version) !== 0) throw new Error(`ocr 装后版本 ${now || '未识别'} ≠ 包内 ${i.version}`);
    console.log(`[offline] ocr 已装至 ${now}。`);
  }

  // ④ 收尾:回归与 baseline 仍留真机——锚定哲学是"baseline = 实测回归通过的版本",离线通道只免下载
  console.log('\n[offline] 应用完成。下一步(与在线升级流程一致):');
  console.log(`[offline]   1. .tools/ 项:把 hook-config.json 对应版本字段改为包内版本,再跑 ${PREFIX}install.js(warmup 见文件即跳过下载)`);
  console.log(`[offline]   2. 回归:build-rules → selftest → ocr preview 冒烟(即 ${PREFIX}upgrade.js 在线模式的步骤②③④)`);
  console.log('[offline]   3. 全绿后把 hook-config.json 的 ocr.baseline 等锚点更新为包内版本,再传导到各项目。');
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
