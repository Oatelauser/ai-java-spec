#!/usr/bin/env node
'use strict';

/*
 * 项目级质量 hook runner —— ZCode PostToolUse / Stop 事件的统一入口。
 *
 * 检查项(全部由 scripts/hook-config.json 开关/换版本,脚本本身零版本感知):
 *   formatter  google-java-format(style 可配 aosp/google),支持自动修复
 *   convention PMD 规则集(默认 PMD7 quickstart;可切 PMD6.55 + p3c 阿里规约)
 *   security   PMD security 分类(与 convention 同一条 per-file 秒级链路,浅层源码检查)
 *   deepScan   可选:编译后 SpotBugs+FindSecBugs 字节码扫描(默认关,仅 Stop 层)
 *
 * 增量策略:PostToolUse 只查刚编辑的单个 .java(CLI 直调,不起 Maven);
 *           Stop 聚合本回合 touched files 去重复查,兜住 Bash 重定向写文件等绕过路径。
 *
 * 反馈协议(与 ZCode hooks 约定对齐):有违规或发生自动格式化 → stderr 摘要 + exit 2 回灌给 agent;
 *           干净 → exit 0 静默;runner 自身故障 → stderr 说明 + exit 0,绝不因自身问题阻塞编辑。
 *
 * 环境要求:JAVA_HOME(JDK 11+,仅作为工具 JVM,与项目 JDK 版本解耦);首次运行需联网下载工具到 .tools/。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// 沙箱/代理环境常设 NODE_TLS_REJECT_UNAUTHORIZED=0,node 会往 stderr 打警告污染 hook 回灌,压掉
process.removeAllListeners('warning');

const ROOT = process.env.ZCODE_PROJECT_DIR
  ? path.resolve(process.env.ZCODE_PROJECT_DIR)
  : path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, '.tools');
const STATE_DIR = path.join(TOOLS_DIR, 'hook-state');
const QUEUE_FILE = path.join(STATE_DIR, 'touched-files.txt');
const IS_WIN = process.platform === 'win32';

const cfg = loadConfig();

main().then(exit).catch(err => {
  // warmup 是人手动跑的命令,失败必须以非零退出码暴露;hook 模式才走"静默降级"
  if (process.argv[2] === 'warmup') {
    console.error(`[quality-hook] 预热失败: ${err && err.message}`);
    process.exit(1);
  }
  failSoftly(err);
});

async function main() {
  const mode = process.argv[2];
  if (mode === 'post-tool-use') return handlePostToolUse();
  if (mode === 'stop') return handleStop();
  if (mode === 'warmup') return handleWarmup();
  throw new Error(`未知模式 "${mode}"(可用: post-tool-use | stop | warmup)`);
}

// 预热:只做工具下载/解压,不检查任何文件。init 新项目后手动跑一次,
// 把首跑约 70MB 的下载成本从"第一次编辑"挪到"项目初始化",下载问题也能当场暴露。
async function handleWarmup() {
  if (cfg.formatter && cfg.formatter.enabled) {
    const jar = await ensureTool(
      path.join(TOOLS_DIR, 'google-java-format', `gjf-${cfg.formatter.version}.jar`),
      gjfDownloadUrls(cfg.formatter.version),
      `google-java-format ${cfg.formatter.version}`,
    );
    console.log(`[warmup] google-java-format ${cfg.formatter.version} 就绪: ${path.relative(ROOT, jar)}`);
  }
  if (cfg.convention && cfg.convention.enabled) {
    const home = await ensurePmd(cfg.convention);
    console.log(`[warmup] PMD ${cfg.convention.version} 就绪: ${path.relative(ROOT, home)}`);
  }
  if (cfg.deepScan && cfg.deepScan.enabled) {
    const home = await ensureSpotBugs();
    console.log(`[warmup] SpotBugs ${cfg.deepScan.spotbugsVersion} 就绪: ${path.relative(ROOT, home)}`);
  }
  console.log('[warmup] 预热完成,后续 hook 检查不再需要联网。');
  return 0;
}

// ---------------------------------------------------------------- 事件处理

async function handlePostToolUse() {
  const input = readStdinJson();
  const file = input && input.tool_input && input.tool_input.file_path;
  if (!file || !file.endsWith('.java') || isIgnoredPath(file)) return 0;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(QUEUE_FILE, normalizeSlashes(file) + '\n');

  return report(await checkFiles([path.resolve(ROOT, file)], { deepScan: false }), '编辑后单文件增量检查');
}

async function handleStop() {
  const files = collectTouchedFiles();
  if (files.length === 0) return 0;

  const result = await checkFiles(files, { deepScan: cfg.deepScan && cfg.deepScan.enabled });
  clearQueue();
  return report(result, `回合聚合复查(${files.length} 个 .java)`);
}

// ---------------------------------------------------------------- 检查链路

async function checkFiles(files, opts) {
  const result = { violations: [], notes: [], fixed: [] };
  if (cfg.formatter && cfg.formatter.enabled) await runFormatter(files, result);
  if ((cfg.convention && cfg.convention.enabled) || (cfg.security && cfg.security.enabled)) {
    await runPmd(files, result);
  }
  if (opts.deepScan) await runDeepScan(result);
  return result;
}

async function runFormatter(files, result) {
  const jar = await ensureTool(
    path.join(TOOLS_DIR, 'google-java-format', `gjf-${cfg.formatter.version}.jar`),
    gjfDownloadUrls(cfg.formatter.version),
    `google-java-format ${cfg.formatter.version}`,
  ).catch(e => result.notes.push(`格式化工具就绪失败(已跳过): ${e.message}`) && null);
  if (!jar) return;

  const javaExe = findJava();
  const styleArgs = cfg.formatter.style === 'google' ? [] : ['--aosp'];
  const dryArgs = ['-Dfile.encoding=UTF-8', '-jar', jar, ...styleArgs, '--dry-run', '--set-exit-if-changed', ...files];

  const dry = run(javaExe, dryArgs, { timeoutMs: 90000 });
  if (runFailedForMissingBinary(dry, result, 'java')) return;
  if (dry.status === 0) return;

  if (!cfg.formatter.autoFix) {
    return result.violations.push(`格式不符合 google-java-format(${cfg.formatter.style}): ${files.map(f => path.basename(f)).join(', ')}`);
  }
  // GJF 对个别输入(如超长字符串断行)非幂等:第一轮产物再跑一轮还会变。
  // 迭代到不动点(上限 3 轮),否则复验必然误报"未格式化"。
  let verify = dry;
  for (let pass = 0; pass < 3 && verify.status !== 0; pass++) {
    run(javaExe, ['-Dfile.encoding=UTF-8', '-jar', jar, ...styleArgs, '--replace', ...files], { timeoutMs: 90000 });
    verify = run(javaExe, dryArgs, { timeoutMs: 90000 });
  }
  if (verify.status === 0) {
    result.fixed.push(...files);
  } else {
    result.violations.push(`多轮格式化后仍未通过复验(多为语法错误,请先修正): ${brief(verify.stderr || verify.stdout, 5)}`);
  }
}

async function runPmd(files, result) {
  const conv = cfg.convention || {};
  const rulesets = [conv.enabled && conv.rulesets, cfg.security && cfg.security.enabled && cfg.security.rulesets]
    .filter(Boolean)
    .join(',');
  if (!rulesets) return;

  const home = await ensurePmd(conv).catch(e => result.notes.push(`PMD 就绪失败(已跳过): ${e.message}`) && null);
  if (!home) return;

  // 缓存文件必须随"版本+规则集组合"隔离,否则 PMD 增量缓存会跨组合给出过期结论
  const cacheKey = crypto.createHash('md5').update(`${conv.version}|${rulesets}`).digest('hex').slice(0, 12);
  const cacheFile = path.join(TOOLS_DIR, 'pmd-cache', `${cacheKey}.cache`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });

  // PMD 7 用 `pmd check` 子命令语法;PMD 6 只有裸选项,且不认 --use-version
  const isPmd6 = /^6\./.test(conv.version);
  const args = [];
  if (!isPmd6) args.push('check', '--no-progress');
  args.push('-f', 'text', '-R', rulesets, '-d', files.join(','), '--cache', cacheFile);
  if (cfg.javaLanguageLevel && !isPmd6) args.push('--use-version', `java-${cfg.javaLanguageLevel}`);

  const r = runPmdScript(home, args, { timeoutMs: 180000 });
  if (r.status === 0) return;
  if (r.status === 4) {
    const hits = (r.stdout || '').split(/\r?\n/).filter(l => /^\S+:\d+:\s+\S/.test(l));
    result.violations.push(...hits.slice(0, 12).map(l => `[PMD] ${l.trim().slice(0, 200)}`));
    if (hits.length > 12) result.violations.push(`[PMD] ...另有 ${hits.length - 12} 条违规(规则集: ${rulesets})`);
  } else {
    result.notes.push(`PMD 执行异常 exit=${r.status}: ${brief(r.stderr || r.stdout)}`);
  }
}

async function runDeepScan(result) {
  if (!fs.existsSync(path.join(ROOT, 'pom.xml'))) {
    return result.notes.push('deepScan 未执行: 根目录未检测到 pom.xml(当前仅支持 Maven 项目)');
  }
  const mvn = detectMaven();
  if (!mvn) return result.notes.push('deepScan 未执行: 未找到 mvnw / mvn');

  const compiled = run(mvn.cmd, ['-q', '-DskipTests', 'compile'], { timeoutMs: 600000, cwd: ROOT });
  if (compiled.status !== 0) {
    return result.violations.push(`[deepScan] 编译失败,SpotBugs 未执行(先修编译错误):\n${brief(compiled.stderr || compiled.stdout, 5)}`);
  }

  const home = await ensureSpotBugs().catch(e => result.notes.push(`SpotBugs 就绪失败(已跳过): ${e.message}`) && null);
  if (!home) return;
  const classesDirs = collectClassesDirs(ROOT);
  if (classesDirs.length === 0) return result.notes.push('deepScan 未执行: 未找到 target/classes');

  const ds = cfg.deepScan;
  const plugin = ds.findsecbugsVersion
    ? ['-pluginList', path.join(home, 'plugin', `findsecbugs-plugin-${ds.findsecbugsVersion}.jar`)]
    : [];
  const thresholdArg = { Low: '-low', Medium: '-medium', High: '-high' }[ds.threshold] || '-medium';
  const script = IS_WIN ? path.join(home, 'bin', 'spotbugs.bat') : path.join(home, 'bin', 'spotbugs');
  const r = run(script, [...plugin, `-effort:${ds.effort || 'Max'}`, thresholdArg, '-exitcode', '-sortByClass', ...classesDirs], { timeoutMs: 600000 });
  if (r.status === 0) return;
  if (r.status === 1) {
    const hits = (r.stdout || '').split(/\r?\n/).filter(l => /^[HMLE]\w*\s+[BMN]\s+\S/.test(l.trim())).slice(0, 10);
    result.violations.push(...hits.map(l => `[SpotBugs] ${l.trim().slice(0, 200)}`));
  } else {
    result.notes.push(`SpotBugs 执行异常 exit=${r.status}: ${brief(r.stderr || r.stdout)}`);
  }
}

// ---------------------------------------------------------------- 汇报与退出

function report(result, header) {
  const hasProblem = result.violations.length > 0 || result.fixed.length > 0;
  if (!hasProblem && result.notes.length === 0) return 0;

  const lines = [`[quality-hook] ${header}`];
  if (result.fixed.length > 0) {
    lines.push(`已自动格式化 ${result.fixed.length} 个文件(内容已变化,后续编辑前请重新 Read): ${result.fixed.map(f => path.basename(f)).join(', ')}`);
  }
  lines.push(...result.violations);
  if (result.violations.length > 0) lines.push('请修复上述违规后重试;规则集与开关见 scripts/hook-config.json。');
  lines.push(...result.notes);

  console.error(lines.join('\n').slice(0, 3000));
  return hasProblem ? 2 : 0;
}

function exit(code) {
  process.exit(code || 0);
}

function failSoftly(err) {
  // runner 自身故障绝不阻塞编辑流程:只留痕,不阻断
  console.error(`[quality-hook] runner 内部错误(已忽略,不阻塞编辑): ${err && err.message}`);
  process.exit(0);
}

// ---------------------------------------------------------------- touched-files 队列

function collectTouchedFiles() {
  const queued = fs.existsSync(QUEUE_FILE)
    ? fs.readFileSync(QUEUE_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const all = [...queued.map(p => path.resolve(ROOT, p)), ...gitChangedJavaFiles()];
  return [...new Set(all.map(normalizeSlashes))]
    .filter(p => p.endsWith('.java') && !isIgnoredPath(p) && fs.existsSync(p));
}

function clearQueue() {
  if (fs.existsSync(QUEUE_FILE)) fs.rmSync(QUEUE_FILE, { force: true });
}

// git 兜底是尽力而为:中文路径在 core.quotepath 下会被转义,失败/为空都不影响队列主线
function gitChangedJavaFiles() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return [];
  try {
    const r = run('git', ['status', '--porcelain', '--untracked-files=all'], { timeoutMs: 15000 });
    if (r.status !== 0) return [];
    return (r.stdout || '')
      .split(/\r?\n/)
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
      .filter(p => p.endsWith('.java') && !isIgnoredPath(p))
      .map(p => path.resolve(ROOT, p));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 工具自举(.tools/)

async function ensureTool(dest, urlCandidates, label) {
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const lastError = await downloadFirstAvailable(urlCandidates, dest);
  if (lastError) throw new Error(`${label} 下载失败: ${lastError.message}`);
  return dest;
}

function gjfDownloadUrls(version) {
  return [
    `https://repo1.maven.org/maven2/com/google/googlejavaformat/google-java-format/${version}/google-java-format-${version}-all-deps.jar`,
    `https://github.com/google/google-java-format/releases/download/v${version}/google-java-format-${version}-all-deps.jar`,
  ];
}

async function ensurePmd(conv) {
  const version = conv.version;
  const installDir = path.join(TOOLS_DIR, 'pmd', `pmd-${version}`);
  let script = findInHome(installDir, 'pmd');
  if (!script) {
    const zip = `${installDir}.zip`;
    if (!fs.existsSync(zip)) {
      const urls = [
        `https://github.com/pmd/pmd/releases/download/pmd_releases%2F${version}/pmd-dist-${version}-bin.zip`,
        `https://github.com/pmd/pmd/releases/download/pmd_releases%2F${version}/pmd-bin-${version}.zip`,
        `https://repo1.maven.org/maven2/net/sourceforge/pmd/pmd-dist/${version}/pmd-dist-${version}-bin.zip`,
      ];
      fs.mkdirSync(path.dirname(zip), { recursive: true });
      const lastError = await downloadFirstAvailable(urls, zip);
      if (lastError) throw new Error(`PMD ${version} 下载失败: ${lastError.message}`);
    }
    extractArchive(zip, installDir);
    script = findInHome(installDir, 'pmd');
    if (!script) throw new Error(`PMD ${version} 解压后未找到 bin/pmd`);
  }
  const home = launcherHome(script);

  // p3c 规则集只兼容 PMD6,且含 Kotlin 实现的规则:standalone PMD 需同时放入
  // p3c jar 与 kotlin-stdlib(Maven 环境里是传递依赖,CLI 环境必须显式带上),见 hook-config.pmd6-p3c.json
  if (conv.p3cVersion) {
    const p3cDeps = [
      [`p3c-pmd-${conv.p3cVersion}.jar`, `com/alibaba/p3c/p3c-pmd/${conv.p3cVersion}/p3c-pmd-${conv.p3cVersion}.jar`],
    ];
    if (conv.p3cKotlinVersion) {
      p3cDeps.push(
        [`kotlin-stdlib-${conv.p3cKotlinVersion}.jar`, `org/jetbrains/kotlin/kotlin-stdlib/${conv.p3cKotlinVersion}/kotlin-stdlib-${conv.p3cKotlinVersion}.jar`],
        [`kotlin-stdlib-jdk8-${conv.p3cKotlinVersion}.jar`, `org/jetbrains/kotlin/kotlin-stdlib-jdk8/${conv.p3cKotlinVersion}/kotlin-stdlib-jdk8-${conv.p3cKotlinVersion}.jar`],
      );
    }
    for (const [name, path664] of p3cDeps) {
      const jarPath = path.join(home, 'lib', name);
      if (!fs.existsSync(jarPath)) {
        await ensureTool(jarPath, [`https://repo1.maven.org/maven2/${path664}`], name);
      }
    }
  }
  return home;
}

async function ensureSpotBugs() {
  const ds = cfg.deepScan;
  const installDir = path.join(TOOLS_DIR, 'spotbugs', `spotbugs-${ds.spotbugsVersion}`);
  let script = findInHome(installDir, 'spotbugs');
  if (!script) {
    const tgz = `${installDir}.tgz`;
    if (!fs.existsSync(tgz)) {
      fs.mkdirSync(path.dirname(tgz), { recursive: true });
      const lastError = await downloadFirstAvailable(
        [
          `https://github.com/spotbugs/spotbugs/releases/download/${ds.spotbugsVersion}/spotbugs-${ds.spotbugsVersion}.tgz`,
          `https://repo1.maven.org/maven2/com/github/spotbugs/spotbugs/${ds.spotbugsVersion}/spotbugs-${ds.spotbugsVersion}.tgz`,
        ],
        tgz,
      );
      if (lastError) throw new Error(`SpotBugs 下载失败: ${lastError.message}`);
    }
    extractArchive(tgz, installDir);
    script = findInHome(installDir, 'spotbugs');
    if (!script) throw new Error('SpotBugs 解压后未找到 bin/spotbugs');
  }
  const home = launcherHome(script);
  const pluginDir = path.join(home, 'plugin');
  const fsbName = `findsecbugs-plugin-${ds.findsecbugsVersion}.jar`;
  if (ds.findsecbugsVersion && !fs.existsSync(path.join(pluginDir, fsbName))) {
    await ensureTool(
      path.join(pluginDir, fsbName),
      [`https://repo1.maven.org/maven2/com/h3xstream/findsecbugs/findsecbugs-plugin/${ds.findsecbugsVersion}/findsecbugs-plugin-${ds.findsecbugsVersion}.jar`],
      `findsecbugs ${ds.findsecbugsVersion}`,
    );
  }
  return home;
}

// 发行包解压后常带一层 pmd-bin-x.y.z/ 目录,这里返回真正含 bin/ 的那一层
function launcherHome(script) {
  return path.dirname(path.dirname(script));
}

function findInHome(home, launcherName) {
  const candidates = [home, ...listDirs(home, 2)];
  for (const dir of candidates) {
    const script = IS_WIN ? path.join(dir, 'bin', `${launcherName}.bat`) : path.join(dir, 'bin', launcherName);
    if (fs.existsSync(script)) return script;
  }
  return null;
}

function listDirs(dir, depth) {
  if (depth < 0 || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .flatMap(e => {
        const full = path.join(dir, e.name);
        return [full, ...listDirs(full, depth - 1)];
      });
  } catch {
    return [];
  }
}

const RETRYABLE_NET_ERROR = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|超时|CONNECT 失败/;

async function downloadFirstAvailable(urls, dest) {
  const failures = [];
  for (const url of urls) {
    // 网络类抖动(超时/连接重置)重试一次;HTTP 4xx/5xx 是确定性失败,直接换下一个候选源
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await download(url, dest, 5);
        return null;
      } catch (e) {
        failures.push(`${e.message} <- ${url}`);
        if (!RETRYABLE_NET_ERROR.test(e.message)) break;
      }
    }
  }
  return new Error(`全部候选源失败: ${failures.join(' | ')}`);
}

function download(url, dest, redirectsLeft) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('重定向次数过多'));
    const req = httpsGet(
      url,
      { headers: { 'user-agent': 'zcode-quality-hook' } },
      res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(download(next, dest, redirectsLeft - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const tmp = `${dest}.tmp-${process.pid}`;
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => out.close(err => (err ? reject(err) : resolve(renameIntoPlace(tmp, dest)))));
        out.on('error', reject);
      },
      reject,
    );
    req.setTimeout(120000, () => req.destroy(new Error(`下载超时 ${url}`)));
  });
}

// 企业网/代理环境支持:设置 HTTPS_PROXY 时经 CONNECT 隧道走代理(node 不自动识别代理变量)
function httpsGet(url, options, onResponse, onError) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) {
    const req = https.get(url, options, onResponse);
    req.on('error', onError);
    return req;
  }
  const target = new URL(url);
  const proxyUrl = new URL(proxy);
  const connectReq = http.request({
    host: proxyUrl.hostname,
    port: Number(proxyUrl.port) || 80,
    method: 'CONNECT',
    path: `${target.hostname}:443`,
  });
  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      connectReq.destroy();
      return onError(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`));
    }
    const inner = https.get(url, { ...options, agent: new https.Agent({ socket }) }, onResponse);
    inner.on('error', onError);
  });
  connectReq.on('error', onError);
  return connectReq;
}

function renameIntoPlace(tmp, dest) {
  try {
    fs.renameSync(tmp, dest);
  } catch {
    // Windows 上目标已存在时 rename 会失败,清掉再改名(并发下载同一文件的兜底)
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  }
}

function extractArchive(archive, destDir) {
  if (findInHome(destDir, 'pmd') || findInHome(destDir, 'spotbugs')) return;
  fs.mkdirSync(destDir, { recursive: true });
  const strategies = [
    ['unzip', ['-o', archive, '-d', destDir]],
    ['tar', ['-xf', archive, '-C', destDir]],
  ];
  if (IS_WIN) {
    strategies.push([
      'powershell',
      ['-NoProfile', '-Command', `Microsoft.PowerShell.Archive\\Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${destDir}'`],
    ]);
  }
  for (const [cmd, args] of strategies) {
    if (run(cmd, args, { timeoutMs: 300000 }).status === 0) return;
  }
  throw new Error(`解压失败: ${archive}`);
}

// ---------------------------------------------------------------- 进程与环境

function run(cmd, args, opts = {}) {
  const viaCmd = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
  return spawnSync(viaCmd ? 'cmd.exe' : cmd, viaCmd ? ['/c', cmd, ...args] : args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120000,
    cwd: opts.cwd || ROOT,
    windowsHide: true,
  });
}

function runPmdScript(home, args, opts) {
  const script = IS_WIN ? path.join(home, 'bin', 'pmd.bat') : path.join(home, 'bin', 'pmd');
  return run(script, args, opts);
}

function findJava() {
  const home = process.env.JAVA_HOME;
  if (home) {
    const exe = path.join(home, 'bin', IS_WIN ? 'java.exe' : 'java');
    if (fs.existsSync(exe)) return exe;
  }
  return 'java'; // 是否可用交给运行时的 ENOENT 检测兜底,避免每次 hook 多起一次探测进程
}

function runFailedForMissingBinary(r, result, name) {
  if (r.error && r.error.code === 'ENOENT') {
    result.notes.push(`未找到 ${name}(请检查 PATH/JAVA_HOME),相关检查已跳过`);
    return true;
  }
  return false;
}

function detectMaven() {
  for (const candidate of IS_WIN ? ['mvnw.cmd', 'mvn.cmd'] : ['mvnw', 'mvn']) {
    if (candidate.startsWith('mvnw') && !fs.existsSync(path.join(ROOT, candidate))) continue;
    if (run(candidate, ['-v'], { timeoutMs: 30000 }).status === 0) return { cmd: candidate };
  }
  return null;
}

function collectClassesDirs(dir) {
  const skip = new Set(['.git', '.tools', 'node_modules', 'src']);
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !skip.has(e.name)) {
        if (e.name === 'target' && fs.existsSync(path.join(full, 'classes'))) return [path.join(full, 'classes')];
        return collectClassesDirs(full);
      }
      return [];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 小工具

function loadConfig() {
  const file = path.join(__dirname, 'hook-config.json');
  if (!fs.existsSync(file)) throw new Error(`缺少 ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`[quality-hook] hook 输入解析失败(按无文件处理,不阻塞): ${e.message}`);
    return {};
  }
}

function isIgnoredPath(p) {
  return /(^|[\\/])(target|build|node_modules|\.tools|\.git)([\\/]|$)/.test(normalizeSlashes(p));
}

function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

function brief(text, maxLines = 3) {
  return (text || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, maxLines)
    .join(' | ')
    .slice(0, 400);
}
