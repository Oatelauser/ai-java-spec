#!/usr/bin/env node
'use strict';

/*
 * 项目级质量 hook runner —— ZCode PostToolUse / Stop 事件的统一入口。
 *
 * 检查项(全部由 scripts/hook-config.json 开关/换版本,脚本本身零版本感知):
 *   formatter  google-java-format(style 可配 aosp/google),回合末统一自动修复
 *   convention PMD 规则集(默认 PMD7 quickstart;可切 PMD6.55 + p3c 阿里规约)
 *   security   PMD security 分类(与 convention 同一条 per-file 秒级链路,浅层源码检查)
 *   deepScan   可选:编译后 SpotBugs+FindSecBugs 字节码扫描(默认关,仅 Stop 层)
 *
 * 增量策略:PostToolUse 对刚编辑的单个 .java 做只读检查(CLI 直调,不重写文件);
 *           Stop 聚合本回合 touched files,统一格式化(重写)+ 复查,兜住 Bash 写文件等绕过路径。
 *           格式化重写刻意只在回合末做:编辑中途重写会立刻作废 agent 的文件缓存
 *           (连续撞 Edit 的 modified-since-read 护栏),并误删增量编辑中间态的无引用 import。
 *
 * 反馈协议(实测校准):有违规或发生自动格式化 → stdout 输出 additionalContext JSON 注入会话回灌给 agent
 *           (PostToolUse 的 stderr/exit2 通道不注入,勿改回);干净 → 静默;runner 自身故障 → 留痕不阻塞。
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

// 多宿主:ZCode 用 ZCODE_PROJECT_DIR,Claude Code 用 CLAUDE_PROJECT_DIR,缺省回退脚本自身定位
const ROOT = process.env.ZCODE_PROJECT_DIR
  || process.env.CLAUDE_PROJECT_DIR
  || path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, '.tools');
const STATE_DIR = path.join(TOOLS_DIR, 'hook-state');
const QUEUE_FILE = path.join(STATE_DIR, 'touched-files.txt');
const LEDGER_FILE = path.join(STATE_DIR, 'findings.json');
const LEDGER_HISTORY = path.join(STATE_DIR, 'findings-history.log');
const IS_WIN = process.platform === 'win32';

const cfg = loadConfig();

// warmup/install 是人手动跑的:下载过程实时打印每个候选地址,断网时可照抄去浏览器手动下载;
// hook 触发的下载保持静默(成功不产生噪音;失败时错误信息里已带全部地址与存放路径)
let announceDownloads = false;

async function main() {
  const mode = process.argv[2];
  if (mode === 'post-tool-use') return handlePostToolUse();
  if (mode === 'stop') return handleStop();
  if (mode === 'warmup') return handleWarmup();
  if (mode === 'pre-tool-use') return handlePreToolUse();
  if (mode === 'bash-gate') return handleBashGate();
  throw new Error(`未知模式 "${mode}"(可用: pre-tool-use | post-tool-use | stop | bash-gate | warmup)`);
}

// 预热:只做工具下载/解压,不检查任何文件。init 新项目后手动跑一次,
// 把首跑约 70MB 的下载成本从"第一次编辑"挪到"项目初始化",下载问题也能当场暴露。
async function handleWarmup() {
  announceDownloads = true;
  ensureGitignoreIgnoresTools();
  if (cfg.formatter && cfg.formatter.enabled) {
    const jar = await ensureTool(
      path.join(TOOLS_DIR, 'google-java-format', `gjf-${cfg.formatter.version}.jar`),
      gjfDownloadUrls(cfg.formatter.version),
      `google-java-format ${cfg.formatter.version}`,
      [path.join(TOOLS_DIR, 'google-java-format', `google-java-format-${cfg.formatter.version}-all-deps.jar`)],
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

// 写入前高危门(借鉴 mimosa 的分级响应:只有"确定性高危"才 deny,规范类仍走事后回灌)。
// 刻意用毫秒级正则而非 PMD:写入前门的性能契约是秒级预算的百分之一,重引擎留给 PostToolUse。
const HIGH_RISK_PATTERNS = [
  { name: '私钥内容', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  // 负向环视排除 !=/>=/==/+= 等复合运算符:比较口令与字面量(if (password != "x"))是合法代码,不是硬编码
  { name: '硬编码口令/密钥赋值', re: /\b(?:password|passwd|secret|apiKey|api_key|accessKey|access_key|token)\b[^=;\n]{0,20}(?<![=!<>+\-*/%&|^])=(?!=)\s*"[^"\n]{6,}"/i },
  { name: 'AWS AccessKey(AKIA)', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'OpenAI 风格密钥(sk-)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub Token(ghp_)', re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'Slack Token(xox*)', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

async function handlePreToolUse() {
  const ti = (readStdinJson().tool_input) || {};
  const file = ti.file_path;
  if (!file || !file.endsWith('.java') || isIgnoredPath(file)) return 0;
  const content = typeof ti.content === 'string' ? ti.content : (typeof ti.new_string === 'string' ? ti.new_string : '');
  if (!content) return 0;

  const hits = [];
  for (const p of HIGH_RISK_PATTERNS) {
    const m = p.re.exec(content);
    if (m) hits.push({ name: p.name, line: content.slice(0, m.index).split('\n').length });
  }
  if (hits.length === 0) return 0;

  return deny([
    '[quality-hook] 写入前高危检查:检测到疑似硬编码密钥/凭据,已阻断写入',
    ...hits.slice(0, 3).map(h => `  第 ${h.line} 行:${h.name}`),
    '请改用环境变量/配置中心/密钥管理,不要把明文密钥写进源码;移除后重试。',
  ].join('\n'));
}

async function handleBashGate() {
  const cmd = readStdinJson().tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) return 0;

  const bypass = detectShellWriteBypass(cmd);
  if (bypass) {
    return deny(`[quality-hook] 命令门禁:检测到用 shell 命令直接写/改 .java(${bypass}),会绕过质量扫描。\n请改用 Write/Edit 工具写入源码,以进入规范/安全检查链路。`);
  }
  // git 必须处于命令位(行首/操作符之后),且 commit/push 是子命令位——
  // 否则 "echo git commit"、"git log --grep commit" 这类文本会被误触发;
  // 参数段允许"带值参数"(如 -C dir)出现在子命令之前
  if (/(?:^|[;&|(`$]\s*)git\s+(?:-[^\s]+(?:\s+[^\s-]\S*)?\s+)*(?:commit|push)\b/.test(cmd)) return gitGate();
  return 0;
}

function detectShellWriteBypass(cmd) {
  if (!/\S*\.java\b/.test(cmd)) return null;
  // (?![.\w]):排除 .java.txt/.java.bak 等以 .java 为前缀的非 Java 目标
  if (/>\s*\S*\.java(?![.\w])/.test(cmd)) return '重定向写入 .java';
  if (/\bsed\b[^&|;\n]*\s-i/.test(cmd)) return 'sed 就地修改 .java';
  if (/\btee\b[^&|;\n]*\S*\.java(?![.\w])/.test(cmd)) return 'tee 写入 .java';
  // PowerShell 宿主(Claude Code Windows 的 shell 工具)的写入形态;
  // cmdlet 后要求空白+可选参数再接 .java,避免把"读一个名叫 out-file.java 的文件"误判
  if (/\b(?:out-file|set-content|add-content)\s+(?:-[a-z]+\s+)*\S*\.java(?![.\w])/i.test(cmd)) return 'PowerShell cmdlet 写入 .java';
  if (/\bwriteall(?:text|lines|bytes)\b[^&|;\n]*\.java/i.test(cmd)) return '.NET WriteAll* 写入 .java';
  return null;
}

// Git 提交/推送门:改动的 .java 必须通过 PMD 才放行;文件数超上限时按失败模式降级
function gitGate() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return 0;
  const changed = gitChangedJavaFiles();
  if (changed.length === 0) return 0;

  const cap = (cfg.performance && cfg.performance.gitGateMaxFiles) || 20;
  if (changed.length > cap) {
    if (isStrict()) {
      return deny(`[quality-hook] Git 门禁:改动 .java 共 ${changed.length} 个,超过上限 ${cap},strict 模式拒绝放行;请分批提交或调整 performance.gitGateMaxFiles`);
    }
    console.error(`[quality-hook] Git 门禁:改动 .java 共 ${changed.length} 个超过 ${cap},本轮跳过检查(partial/INCONCLUSIVE)`);
    return 0;
  }
  const result = { violations: [], notes: [], fixed: [] };
  return runPmd(changed, result).then(() => {
    // notes 必须留痕(stderr 进日志可查);strict 模式下检查未完全就绪按 fail-closed 阻断,兑现 strict 承诺
    result.notes.forEach(n => console.error(`[quality-hook] ${n}`));
    if (isStrict() && result.notes.length > 0) {
      return deny(['[quality-hook] Git 门禁:strict 模式下检查未完全就绪,阻断(fail-closed)', ...result.notes.slice(0, 3)].join('\n'));
    }
    if (result.violations.length === 0) return 0;
    return deny([
      `[quality-hook] Git 门禁:改动代码存在 ${result.violations.length} 处未修复违规,已阻断提交/推送`,
      ...result.violations.slice(0, 5),
      '请修复后重试;规则集与开关见 scripts/hook-config.json。',
    ].join('\n'));
  });
}

// PreToolUse 的拒绝,按宿主分派输出形状(两宿主均真机校准):
// ZCode:exit 2 + {decision:'deny'}(阻断可靠);
// Claude Code:顶层 decision 只收 approve|block,"deny" 必须走 hookSpecificOutput.permissionDecision;
// legacy 形状会被其 schema 校验整体拒绝并 fail-open 放行(v2.1.278 真机实测:命令照跑、文件落盘),
// 故该宿主 exit 0 仅凭 JSON 表意
function deny(reason) {
  if (!process.env.ZCODE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }));
    return 0;
  }
  process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
  return 2;
}

function isStrict() {
  return (cfg.failureMode || 'open') === 'strict';
}

async function handlePostToolUse() {
  const input = readStdinJson();
  const file = input && input.tool_input && input.tool_input.file_path;
  if (!file || !file.endsWith('.java') || isIgnoredPath(file)) return 0;

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(QUEUE_FILE, normalizeSlashes(file) + '\n');
  ensureGitignoreIgnoresTools();

  return report(await checkFiles([path.resolve(ROOT, file)], { format: false, deepScan: false }), '编辑后单文件增量检查');
}

async function handleStop() {
  const files = collectTouchedFiles();
  if (files.length === 0) return 0;
  ensureGitignoreIgnoresTools();

  // 存量项目 git 脏文件可能很多,复查设上限防止 Stop 超时(队列文件优先,超额部分如实标注)
  const cap = (cfg.performance && cfg.performance.stopMaxFiles) || 30;
  const skipped = Math.max(0, files.length - cap);
  const checked = skipped > 0 ? files.slice(0, cap) : files;

  const result = await checkFiles(checked, { format: true, deepScan: cfg.deepScan && cfg.deepScan.enabled });
  if (skipped > 0) result.notes.push(`另有 ${skipped} 个改动文件未复查(超过 performance.stopMaxFiles=${cap},partial/INCONCLUSIVE)`);
  applyFindingLedger(result, checked);
  clearQueue();
  return report(result, `回合聚合复查(${checked.length} 个 .java)`);
}

// ---------------------------------------------------------------- 检查链路

async function checkFiles(files, opts) {
  const result = { violations: [], notes: [], fixed: [] };
  // 格式化重写只允许发生在回合末(opts.format):编辑中途重写会作废 agent 缓存、误删中间态 import
  if (opts.format && cfg.formatter && cfg.formatter.enabled) await runFormatter(files, result);
  if ((cfg.convention && cfg.convention.enabled) || (cfg.security && cfg.security.enabled)) {
    // PostToolUse 同理容忍"未使用类"中间态:单次编辑看不到整个回合的意图,Stop 全量兜底
    const suppress = opts.format ? [] : ((cfg.postToolUse && cfg.postToolUse.suppressRules) || EDIT_TIME_SUPPRESSED_RULES);
    await runPmd(files, result, suppress);
  }
  if (opts.deepScan) await runDeepScan(result);
  return result;
}

// 编辑期默认容忍的规则:声明的 import/字段/变量常在"下一次编辑"才被使用
const EDIT_TIME_SUPPRESSED_RULES = [
  'UnnecessaryImport',
  'UnusedPrivateField',
  'UnusedLocalVariable',
  'UnusedPrivateMethod',
  'UnusedFormalParameter',
];

async function runFormatter(files, result) {
  const jar = await ensureTool(
    path.join(TOOLS_DIR, 'google-java-format', `gjf-${cfg.formatter.version}.jar`),
    gjfDownloadUrls(cfg.formatter.version),
    `google-java-format ${cfg.formatter.version}`,
    [path.join(TOOLS_DIR, 'google-java-format', `google-java-format-${cfg.formatter.version}-all-deps.jar`)],
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

async function runPmd(files, result, suppressedRules = []) {
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
    const visible = suppressedRules.length > 0
      ? hits.filter(l => !suppressedRules.some(rule => new RegExp(`(?:^|\\s)${rule}:\\s`).test(l)))
      : hits;
    result.violations.push(...visible.slice(0, 12).map(l => `[PMD] ${l.trim().slice(0, 200)}`));
    if (visible.length > 12) result.violations.push(`[PMD] ...另有 ${visible.length - 12} 条违规(规则集: ${rulesets})`);
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
  // feedback=quiet 时压掉非风险信息(格式化提示/备注),只留违规本身
  const quiet = cfg.feedback === 'quiet';
  const hasProblem = result.violations.length > 0 || (!quiet && result.fixed.length > 0);
  if (!hasProblem && (quiet || result.notes.length === 0)) return 0;

  const lines = [`[quality-hook] ${header}`];
  if (!quiet && result.fixed.length > 0) {
    lines.push(`已自动格式化 ${result.fixed.length} 个文件(内容已变化,后续编辑前请重新 Read 完整文件——只读部分会让 Edit 匹配失败): ${result.fixed.map(f => path.basename(f)).join(', ')}`);
  }
  lines.push(...result.violations);
  if (result.violations.length > 0) lines.push('请修复上述违规后重试;规则集与开关见 scripts/hook-config.json。');
  if (!quiet) lines.push(...result.notes);

  emitFeedback(process.argv[2], lines.join('\n').slice(0, 3000));
  return 0;
}

// ZCode 实测:PostToolUse 的 stderr/exit2 不会注入会话(副作用生效、文字被吞),
// 回灌必须走 stdout 的 additionalContext JSON。因此 hook 模式下 stdout 只允许这一个 JSON
// (严格 schema,混入其他打印会导致整段输出被丢弃)。
function emitFeedback(mode, message) {
  const event = mode === 'stop' ? 'Stop' : 'PostToolUse';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: message } }));
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

// ---------------------------------------------------------------- finding 台账(借鉴 mimosa)

// Stop 复查的去重与状态化:同一条违规(文件+行+规则)只完整回灌一次,
// 之后只在台账里续期,不再刷屏;本轮未再出现的同文件旧 finding 判定为已修复,写入不可覆盖历史。
function applyFindingLedger(result, checkedFiles) {
  let ledger = { version: 1, findings: {} };
  try {
    if (fs.existsSync(LEDGER_FILE)) ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch {
    ledger = { version: 1, findings: {} };
  }
  const checked = new Set(checkedFiles.map(normalizeSlashes));
  const now = new Date().toISOString();
  const currentKeys = new Set();

  const kept = [];
  let knownCount = 0;
  for (const v of result.violations) {
    const m = /^\[PMD\]\s+(.+?):(\d+):\s+(\S+):/.exec(v);
    if (!m) {
      kept.push(v); // SpotBugs 等其它来源不进台账,原样保留
      continue;
    }
    const [, file, line, rule] = m;
    const key = crypto.createHash('md5').update(`${normalizeSlashes(file)}|${line}|${rule}`).digest('hex');
    currentKeys.add(`${normalizeSlashes(file)}|${key}`);
    if (ledger.findings[key]) {
      ledger.findings[key].lastSeen = now;
      knownCount++;
    } else {
      ledger.findings[key] = { file: normalizeSlashes(file), line: Number(line), rule, firstSeen: now, lastSeen: now };
      kept.push(v);
    }
  }

  const history = [];
  for (const [key, f] of Object.entries(ledger.findings)) {
    const isCurrent = currentKeys.has(`${f.file}|${key}`);
    const fileWasChecked = checked.has(f.file);
    if (!isCurrent && fileWasChecked) {
      history.push(`FIXED ${now} ${f.file}:${f.line} ${f.rule} (firstSeen ${f.firstSeen})`);
      delete ledger.findings[key];
    }
  }

  if (knownCount > 0) {
    kept.push(`[PMD] 另有 ${knownCount} 条此前已报告、本轮未变化的违规不再重复列出(台账: ${path.relative(ROOT, LEDGER_FILE)})`);
  }
  result.violations = kept;

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
    if (history.length > 0) fs.appendFileSync(LEDGER_HISTORY, `${history.join('\n')}\n`);
  } catch {
    // 台账失败不影响回灌主流程
  }
}

// git 兜底是尽力而为:中文路径在 core.quotepath 下会被转义,失败/为空都不影响队列主线
function gitChangedJavaFiles() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return [];
  try {
    const r = run('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 15000 });
    if (r.status !== 0) return [];
    return (r.stdout || '')
      .split(/\r?\n/)
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
      // 重命名条目 "old -> new" 取新路径
      .map(p => p.split(' -> ').pop().trim())
      .filter(p => p.endsWith('.java') && !isIgnoredPath(p))
      .map(p => path.resolve(ROOT, p));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 工具自举(.tools/)

// altNames:手动下载常保留官方原文件名,这里一并识别,免得强迫用户改名
async function ensureTool(dest, urlCandidates, label, altNames = []) {
  const existing = [dest, ...altNames].find(p => fs.existsSync(p));
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const lastError = await downloadFirstAvailable(urlCandidates, dest);
  if (lastError) throw new Error(`${label} 下载失败(${lastError.message})\n${manualDownloadHint(urlCandidates, dest)}`);
  return existing || dest;
}

// 断网/受限网络的自救:给出全部候选地址与精确存放位置,文件放好后重跑即跳过下载
function manualDownloadHint(urls, dest) {
  return [
    '手动安装:用浏览器下载以下任一地址',
    ...urls.map(u => `  ${u}`),
    `存放到(改名): ${dest}`,
    `或(免改名): 保持下载原文件名放入 ${path.dirname(dest)}`,
    '放好后重跑本命令,检测到文件即跳过下载。',
  ].join('\n');
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
    const dir = path.join(TOOLS_DIR, 'pmd');
    const zip = path.join(dir, `pmd-${version}.zip`);
    // 手动放置的发行包常保留官方原始文件名(pmd-dist-<v>-bin.zip / pmd-bin-<v>.zip),同样识别
    let src = [
      zip,
      path.join(dir, `pmd-dist-${version}-bin.zip`),
      path.join(dir, `pmd-bin-${version}.zip`),
    ].find(p => fs.existsSync(p));
    if (!src) {
      await ensureTool(
        zip,
        [
          `https://github.com/pmd/pmd/releases/download/pmd_releases%2F${version}/pmd-dist-${version}-bin.zip`,
          `https://github.com/pmd/pmd/releases/download/pmd_releases%2F${version}/pmd-bin-${version}.zip`,
          `https://repo1.maven.org/maven2/net/sourceforge/pmd/pmd-dist/${version}/pmd-dist-${version}-bin.zip`,
        ],
        `PMD ${version}`,
      );
      src = zip;
    }
    extractArchive(src, installDir);
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
    await ensureTool(
      tgz,
      [
        `https://github.com/spotbugs/spotbugs/releases/download/${ds.spotbugsVersion}/spotbugs-${ds.spotbugsVersion}.tgz`,
        `https://repo1.maven.org/maven2/com/github/spotbugs/spotbugs/${ds.spotbugsVersion}/spotbugs-${ds.spotbugsVersion}.tgz`,
      ],
      `SpotBugs ${ds.spotbugsVersion}`,
    );
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
        if (announceDownloads) console.log(`[download] ${url}`);
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
        res.on('error', reject);
        out.on('finish', () => out.close(err => {
          if (err) return reject(err);
          // renameIntoPlace 在流回调里执行,抛异常会绕过 main 的 catch(failSoftly 接不住),故返回布尔
          if (!renameIntoPlace(tmp, dest)) return reject(new Error(`落盘失败(目标被占用或只读): ${dest}`));
          resolve();
        }));
        out.on('error', reject);
      },
      reject,
    );
    // 连接阶段 20 秒快速失败(受限网络下死节点常见,死等 120 秒会把 hook 冷启动预算拖爆);
    // 拿到响应后放宽为 120 秒空闲超时,慢速但持续流动的下载不受影响
    req.setTimeout(20000, () => req.destroy(new Error(`连接超时 ${url}`)));
    req.on('response', () => req.setTimeout(120000, () => req.destroy(new Error(`下载超时 ${url}`))));
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
    port: Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80),
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
    return true;
  } catch {
    // Windows 上目标被占用时 rename 失败:清掉重试,再不行退回 copy 兜底
    try {
      fs.rmSync(dest, { force: true });
      fs.renameSync(tmp, dest);
      return true;
    } catch {
      try {
        fs.copyFileSync(tmp, dest);
        fs.rmSync(tmp, { force: true });
        return true;
      } catch {
        return false;
      }
    }
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
  // 残缺安装会让 findInHome 命中缺 lib 的目录且永不自愈——失败即清场
  fs.rmSync(destDir, { recursive: true, force: true });
  throw new Error(`解压失败(已清理残缺目录): ${archive}`);
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

// 纯拷贝安装(preferred 通道)没有任何后续动作,.tools/ 的 git 忽略必须由 runner 首次运行时自己补上
function ensureGitignoreIgnoresTools() {
  try {
    const file = path.join(ROOT, '.gitignore');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/).includes('.tools/')) return;
    fs.appendFileSync(file, `${fs.existsSync(file) ? '\n' : ''}# quality-hook 工具下载缓存\n.tools/\n`);
  } catch {
    // 只读文件系统等场景静默跳过,不影响检查主流程
  }
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

// 入口放在文件末尾:handler 若引用后文声明的常量(如 HIGH_RISK_PATTERNS),顶部立即调用会触发 TDZ
main().then(exit).catch(err => {
  // warmup / 门禁是人手动或阻断语义的命令,失败必须以非零退出码暴露;普通 hook 模式才静默降级
  if (process.argv[2] === 'warmup') {
    console.error(`[quality-hook] 预热失败: ${err && err.message}`);
    process.exit(1);
  }
  if ((process.argv[2] === 'pre-tool-use' || process.argv[2] === 'bash-gate') && isStrict()) {
    deny(`[quality-hook] strict 模式:门禁内部错误,按失败策略阻断(${err && err.message})`);
    process.exit(2);
  }
  failSoftly(err);
});
