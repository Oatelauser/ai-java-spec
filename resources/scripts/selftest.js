#!/usr/bin/env node
'use strict';

/*
 * hook-runner.js / review-mark.js 零依赖回归套件。运行:node scripts/selftest.js
 *
 * 覆盖矩阵:
 *   pre-tool-use  P1-P11(写入前高危门)
 *   bash-gate     B1-B8(Bash 写 .java 绕过检测)+ B12-B17(PowerShell/.NET 写入形态,
 *                 B15 = 读 .java 写 .txt 不误伤的语义钉子)
 *                 B9-B11(git 评审标记门禁:未标记阻断 / 标记后指纹变化阻断 / 标记匹配放行)
 *                 B18-B19(内容盲区:标记后仅改未跟踪/已跟踪脏 .java 的内容,指纹须仍漂移)
 *                 B20(git 命令大小写旁路)+ B21(纯空白改动不漂移指纹,GJF 自动格式化友好)
 *   review-mark   R1-R3(status 缺失输出 / done-status 往返 / 指纹对工作区变化敏感)
 *   post-tool-use U1-U4(.java 只入队不再跑检查;.md/忽略路径不入队;append 语义)
 *   stop          S1-S7(格式化 / ocr preview 注入 / ocr 缺失降级 / 截断 / 队列清理)
 *   协议          J1(post/stop 的 stdout 必须是单个可解析 JSON 且 stderr 为空)
 *   warmup        W1(工具已就绪时秒过)
 *
 * 约定:
 *  - 一律 spawnSync(process.execPath,[runner,mode],{input}) 传 JSON,不走 shell 拼接;
 *  - ocr 的有无用 PATH 控制:临时目录放 ocr 桩并前插 PATH = 确定性"已安装";
 *    PATH 置空 = 确定性"未安装"。评审 LLM 的结论不进断言(只断 preview 通道的外壳行为);
 *  - fixture 全部放 .selftest-tmp/,结束删除;测试前备份 .tools/hook-state,结束后还原;
 *  - git 用例临时 git init + 空初始提交(指纹源含 git diff HEAD,无提交时必败;
 *    hook-lab 原本无 .git),结束 rm -rf .git;
 *  - P11/B6 是"记录实际行为"用例(疑似误报):只如实记录行为,不以断言迁就,也不计 FAIL。
 *
 * fixture 内容对 google-java-format 1.36.1(aosp)实测校准:BAD_JAVA/CLEAN_JAVA 已符合
 * GJF 规范(两次 stop 行号稳定),LONG_JAVA 含 >100 列长行(触发格式化改写)。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LAB = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'hook-runner.js');
const REVIEW_MARK = path.join(__dirname, 'review-mark.js');
const GIT_DIR = path.join(LAB, '.git');
const TMP = path.join(LAB, '.selftest-tmp');
const STATE_DIR = path.join(LAB, '.tools', 'hook-state');
const QUEUE_FILE = path.join(STATE_DIR, 'touched-files.txt');
const PREVIEW_FILE = path.join(STATE_DIR, 'ocr-preview.txt');
const REVIEW_MARK_FILE = path.join(STATE_DIR, 'ocr-review.json');
const BACKUP_DIR = path.join(TMP, '.hook-state-backup');

// ---------------------------------------------------------------- 基础设施

const results = [];
const suspects = []; // 疑似误报(P11/B6):记录实际行为,不计 FAIL

function record(id, ok, msg) {
  results.push({ id, ok, msg });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${msg}`);
}

function runCase(id, fn) {
  try {
    fn();
  } catch (e) {
    record(id, false, `套件自身异常: ${e && e.message}`);
  }
}

// 按启动宿主忠实模拟:用哪个变量启动 selftest,就以哪个(且仅该)变量调 runner;
// 否则 Claude 形状永远走不到,deny 宿主分派就测不出来
const HOST_KEY = process.env.ZCODE_PROJECT_DIR ? 'ZCODE_PROJECT_DIR' : 'CLAUDE_PROJECT_DIR';

// 用规定的 spawnSync 方式调 runner;stdin 传 JSON 字符串,严禁 shell 拼接
function hook(mode, payload, timeoutMs) {
  const env = Object.assign({}, process.env, { [HOST_KEY]: LAB });
  delete env[HOST_KEY === 'ZCODE_PROJECT_DIR' ? 'CLAUDE_PROJECT_DIR' : 'ZCODE_PROJECT_DIR'];
  const res = spawnSync(process.execPath, [RUNNER, mode], {
    input: JSON.stringify(payload === undefined ? {} : payload),
    encoding: 'utf8',
    cwd: LAB,
    env,
    timeout: timeoutMs || 240000,
  });
  if (res.error) throw new Error(`runner 启动失败: ${res.error.message}`);
  if (res.signal) throw new Error(`runner 超时被杀(${res.signal})`);
  return res;
}

// hook() 的 PATH 控制变体:dir 为字符串 → 前插(ocr 桩,模拟已安装);dir 为 null → 置空(模拟未安装)。
// Windows 环境块键大小写不敏感,须先按大小写归一剔除原 PATH 再设,避免 PATH/Path 重复键
function hookPath(mode, payload, dir, timeoutMs) {
  const env = {};
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH';
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== 'path') env[k] = v;
  }
  env[pathKey] = dir ? `${dir}${path.delimiter}${process.env[pathKey]}` : '';
  env[HOST_KEY] = LAB;
  delete env[HOST_KEY === 'ZCODE_PROJECT_DIR' ? 'CLAUDE_PROJECT_DIR' : 'ZCODE_PROJECT_DIR'];
  const res = spawnSync(process.execPath, [RUNNER, mode], {
    input: JSON.stringify(payload === undefined ? {} : payload),
    encoding: 'utf8',
    cwd: LAB,
    env,
    timeout: timeoutMs || 240000,
  });
  if (res.error) throw new Error(`runner 启动失败: ${res.error.message}`);
  if (res.signal) throw new Error(`runner 超时被杀(${res.signal})`);
  return res;
}

// 调 review-mark.js 子命令(done/status),环境与 hook() 同源
function reviewMark(sub) {
  const env = Object.assign({}, process.env, { [HOST_KEY]: LAB });
  delete env[HOST_KEY === 'ZCODE_PROJECT_DIR' ? 'CLAUDE_PROJECT_DIR' : 'ZCODE_PROJECT_DIR'];
  const res = spawnSync(process.execPath, [REVIEW_MARK, sub], { encoding: 'utf8', cwd: LAB, env, timeout: 60000 });
  if (res.error) throw new Error(`review-mark 启动失败: ${res.error.message}`);
  return res;
}

// ocr 桩:临时目录放可执行 ocr(Windows 用 .cmd,Unix 用 shell 脚本),前插 PATH 即"已安装"。
// 内容固定为单行标记,断言只认这个标记——不依赖真机 ocr 的输出
const OCR_STUB_LINE = 'stub-preview:src/main/java/Demo.java';
function makeOcrStub() {
  const dir = path.join(TMP, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'ocr.cmd'), `@echo off\r\necho ${OCR_STUB_LINE}\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'ocr'), `#!/bin/sh\necho '${OCR_STUB_LINE}'\n`);
    fs.chmodSync(path.join(dir, 'ocr'), 0o755);
  }
  return dir;
}

// 指纹的 diff 源是 git diff HEAD,仓库无任何提交时该命令必败 → init 后补一个空初始提交
function gitInitOrFail() {
  const init = spawnSync('git', ['init'], { cwd: LAB, encoding: 'utf8', timeout: 60000 });
  if (init.status !== 0) throw new Error(`git init 失败: ${init.stderr || ''}`);
  gitRun(['-c', 'user.email=selftest@local', '-c', 'user.name=selftest', 'commit', '--allow-empty', '-m', 'selftest-init']);
}

// 测试内直接跑 git(不经宿主与门禁,仅用于铺底:初始提交、把夹具纳入版本管理等)
function gitRun(args) {
  const r = spawnSync('git', args, { cwd: LAB, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${(r.stderr || '').trim()}`);
  return r;
}

function stdoutJson(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    return undefined;
  }
}

function denyJson(res) {
  const out = stdoutJson(res);
  // 两种 deny 形状归一:ZCode=exit2+{decision};Claude=exit0+hookSpecificOutput.permissionDecision
  if (out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny') {
    return { decision: 'deny', reason: out.hookSpecificOutput.permissionDecisionReason || '' };
  }
  return res.status === 2 ? out : undefined;
}

// post/stop 的 stdout:为空,或恰好一个可 JSON.parse 的对象;stderr 必须为空
function protocolProblem(res) {
  if (res.stderr && res.stderr.trim()) return `stderr 非空: ${res.stderr.trim().slice(0, 120)}`;
  if (!res.stdout || !res.stdout.trim()) return null;
  return stdoutJson(res) === undefined ? `stdout 不是单个合法 JSON: ${res.stdout.slice(0, 120)}` : null;
}

function ctxOf(res) {
  const out = stdoutJson(res);
  return out && out.hookSpecificOutput ? String(out.hookSpecificOutput.additionalContext || '') : '';
}

function writeFixture(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // GJF 要求源文件以换行符结尾,夹具统一补齐——否则"已规范"夹具会被 stop 误判需格式化
  fs.writeFileSync(p, content.endsWith(String.fromCharCode(10)) ? content : content + String.fromCharCode(10));
  return p;
}

function wipeState() {
  rmTree(STATE_DIR);
}

// node v25.0.0 实测 fs.rm 系在 Windows 非 ASCII 路径(本仓中文路径)上静默失效,
// 删除一律走 unlink/rmdir 原生绑定 + 手工递归,语义对齐 rmSync(recursive, force)
function rmTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) rmTree(path.join(p, name));
    fs.rmdirSync(p);
  } else {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

function queueLines() {
  return fs.existsSync(QUEUE_FILE)
    ? fs.readFileSync(QUEUE_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
}

function postOn(file) {
  return hook('post-tool-use', { tool_name: 'Write', tool_input: { file_path: file } });
}

function maxLineLen(file) {
  return Math.max(...fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.length));
}

// ---------------------------------------------------------------- fixture(已校准)

const BAD_JAVA = [
  'package selftesttmp;',
  '',
  'public class Bad {',
  '    void run() {',
  '        try {',
  '            helper();',
  '        } catch (Exception e) {',
  '        }',
  '    }',
  '',
  '    int helper() {',
  '        return 5;',
  '    }',
  '}',
].join('\n');

const CLEAN_JAVA = [
  'package selftesttmp;',
  '',
  'public class Clean {',
  '    private int count;',
  '',
  '    public int increment() {',
  '        count += 1;',
  '        return count;',
  '    }',
  '',
  '    public int total(int extra) {',
  '        return count + extra;',
  '    }',
  '}',
].join('\n');

const LONG_JAVA = [
  'package selftesttmp;',
  '',
  'public class LongFile {',
  '    int report() {',
  '        String message = "alpha-beta-gamma-delta-epsilon" + "zeta-eta-theta-iota-kappa-lambda-mu" + "nu-xi-omicron-pi-rho-sigma-tau-upsilon" + "phi-chi-psi-omega-plus-some-more-padding";',
  '        try {',
  '            helper();',
  '        } catch (Exception e) {',
  '        }',
  '        return message.length();',
  '    }',
  '',
  '    int helper() {',
  '        return 5;',
  '    }',
  '}',
].join('\n');

// ---------------------------------------------------------------- pre-tool-use(P1-P11)

function preCases() {
  const j = name => path.join(TMP, 'pre', name); // pre 模式不落盘,路径仅作 payload

  runCase('P1', () => {
    const content = [
      'package selftesttmp;',
      '',
      'public class P1 {',
      '    private static final String PASSWORD = "admin123456";',
      '}',
    ].join('\n');
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P1.java'), content } });
    const out = denyJson(res);
    const reason = out && out.reason ? out.reason : '';
    const line = (reason.match(/第\s*\d+\s*行/) || [''])[0];
    const ok = !!out && out.decision === 'deny' && !!line && reason.includes('硬编码口令');
    record('P1', ok, ok ? `deny 且 reason 带行号(${line}:硬编码口令)` : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P2', () => {
    const content = 'package selftesttmp;\n\npublic class P2 {\n    String value = "AKIAIOSFODNN7EXAMPLE";\n}\n';
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P2.java'), content } });
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('AKIA');
    record('P2', ok, ok ? 'deny(AWS AKIA AccessKey)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P3', () => {
    const content = 'package selftesttmp;\n\npublic class P3 {\n    String header = "sk-proj-abcdefghij1234567890abcdefgh";\n}\n';
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P3.java'), content } });
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && /sk-/.test(out.reason || '');
    record('P3', ok, ok ? 'deny(OpenAI sk- 密钥)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P4', () => {
    const content = 'package selftesttmp;\n\npublic class P4 {\n    String material = "-----BEGIN RSA PRIVATE KEY-----";\n}\n';
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P4.java'), content } });
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('私钥');
    record('P4', ok, ok ? 'deny(RSA 私钥块)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P5', () => {
    const ghp = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O7p6Q7r8'; // 36 位
    const content = `package selftesttmp;\n\npublic class P5 {\n    String auth = "${ghp}";\n}\n`;
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P5.java'), content } });
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && /ghp_/.test(out.reason || '');
    record('P5', ok, ok ? 'deny(GitHub ghp_ 令牌)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P6', () => {
    const res = hook('pre-tool-use', {
      tool_name: 'Edit',
      tool_input: { file_path: j('P6.java'), old_string: 'x', new_string: 'String password = "topsecret-value-99";' },
    });
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('硬编码口令');
    record('P6', ok, ok ? 'deny(Edit new_string 口令赋值)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P7', () => {
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P7.java'), content: CLEAN_JAVA } });
    const ok = res.status === 0 && !(res.stdout || '').trim();
    record('P7', ok, ok ? '干净 .java 放行(exit0 零输出)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P8', () => {
    const content = '    private static final String PASSWORD = "admin123456";\n';
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('notes.md'), content } });
    const ok = res.status === 0 && !(res.stdout || '').trim();
    record('P8', ok, ok ? '.md 放行(仅查 .java)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P9', () => {
    const content = '    private static final String PASSWORD = "admin123456";\n';
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('target/Gen.java'), content } });
    const ok = res.status === 0 && !(res.stdout || '').trim();
    record('P9', ok, ok ? 'target/ 下放行(忽略路径)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('P10', () => {
    const res = hook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: j('P10.java') } });
    const ok = res.status === 0 && !(res.stdout || '').trim();
    record('P10', ok, ok ? '无 content/new_string 放行' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  // P11:记录实际行为(疑似误报:password != "..." 是比较,不是赋值)
  runCase('P11', () => {
    const content = 'package selftesttmp;\n\npublic class P11 {\n    boolean check(String password) {\n        if (password != "wrong-password") {\n            return false;\n        }\n        return true;\n    }\n}\n';
    const res = hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: j('P11.java'), content } });
    const out = denyJson(res);
    if (out && out.decision === 'deny') {
      suspects.push('P11');
      record('P11', true, '实际行为=deny exit2(疑似误报:!= 比较语句被当作硬编码口令赋值阻断)');
    } else {
      record('P11', true, `实际行为=放行(status=${res.status},无 deny)`);
    }
  });
}

// ---------------------------------------------------------------- bash-gate(B1-B17)

function bashCases() {
  const denyBy = (id, command, need) => {
    runCase(id, () => {
      const res = hook('bash-gate', { tool_name: 'Bash', tool_input: { command } });
      const out = denyJson(res);
      const reason = out && out.reason ? out.reason : '';
      const ok = !!out && out.decision === 'deny' && (!need || reason.includes(need));
      record(id, ok, ok ? `deny exit=${res.status}(${need || '写 .java 绕过'})` : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
    });
  };

  denyBy('B1', "cat <<'EOF' > src/A.java\npackage p;\npublic class A {}\nEOF\n", '命令门禁');
  denyBy('B2', 'echo x > Foo.java', '命令门禁');
  denyBy('B3', "sed -i 's/a/b/' A.java", 'sed');
  denyBy('B4', 'echo hello | tee B.java', 'tee');
  denyBy('B12', "Set-Content -Path src/A.java -Value 'public class A {}'", 'PowerShell');
  denyBy('B13', "echo 'public class X{}' | Out-File src/X.java", 'PowerShell');
  denyBy('B14', "[IO.File]::WriteAllText('A.java', 'x')", 'WriteAll');
  denyBy('B16', "[IO.File]::AppendAllText('A.java', 'x')", 'AppendAll');
  denyBy('B17', 'Out-File -Encoding utf8 src/A.java', 'PowerShell');

  runCase('B15', () => {
    const c1 = hook('bash-gate', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content src/A.java | Out-File out.txt' } });
    // 参数带值形态下的同语义命令:写的是 .txt,.java 只被读
    const c2 = hook('bash-gate', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content src/A.java | Out-File -Encoding utf8 out.txt' } });
    const ok = !denyJson(c1) && c1.status === 0 && !denyJson(c2) && c2.status === 0;
    record('B15', ok, ok ? '读 .java 写 .txt 的 PowerShell 管道不误伤(裸/带参数两形态均放行)' : `误伤:status=${c1.status}/${c2.status} stdout=${(c1.stdout || c2.stdout || '').slice(0, 150)}`);
  });

  runCase('B5', () => {
    const res = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'mvn -q test' } });
    const ok = res.status === 0 && !(res.stdout || '').trim();
    record('B5', ok, ok ? 'mvn -q test 放行' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  // B6:记录实际行为(疑似误报:重定向目标是 .txt 而非 .java)
  runCase('B6', () => {
    const res = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'grep foo bar.txt > out.java.txt' } });
    const out = denyJson(res);
    if (out && out.decision === 'deny') {
      suspects.push('B6');
      record('B6', true, '实际行为=deny exit2(疑似误报:输出到 out.java.txt 的重定向被当作写 .java 阻断)');
    } else {
      record('B6', true, `实际行为=放行(status=${res.status},无 deny)`);
    }
  });

  runCase('B8', () => {
    const r1 = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'rm Foo.java' } });
    const r2 = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'javac -d out A.java' } });
    const ok = r1.status === 0 && !(r1.stdout || '').trim() && r2.status === 0 && !(r2.stdout || '').trim();
    record('B8', ok, ok ? 'rm/javac 不误伤(均放行)' : `rm status=${r1.status}, javac status=${r2.status}`);
  });

  // ---- git 评审标记门禁(ocr 用桩保证"已安装"确定性)
  runCase('B9', () => {
    gitInitOrFail();
    const stubDir = makeOcrStub();
    wipeState();
    writeFixture(path.join('gitcase', 'Bad.java'), BAD_JAVA);
    const res = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('未经回合评审');
    record('B9', ok, ok ? 'git 门 deny(有 .java 改动、ocr 在位、无评审标记)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('B10', () => {
    const stubDir = makeOcrStub();
    const mark = reviewMark('done');
    if (mark.status !== 0) throw new Error(`review-mark done 失败: ${mark.stderr || mark.stdout}`);
    writeFixture(path.join('gitcase', 'extra.txt'), 'x'); // 标记后再动工作区 → 指纹漂移
    const res = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('指纹不匹配');
    record('B10', ok, ok ? 'git 门 deny(标记后工作区变化,指纹不匹配)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('B11', () => {
    const stubDir = makeOcrStub();
    const mark = reviewMark('done'); // extra.txt 已在指纹内,重新标记 → 匹配
    if (mark.status !== 0) throw new Error(`review-mark done 失败: ${mark.stderr || mark.stdout}`);
    const r1 = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const okMatch = r1.status === 0 && !(r1.stdout || '').trim();
    // 无 .java 改动时直接放行(不探测 ocr、不看标记)
    rmTree(path.join(TMP, 'gitcase'));
    const r2 = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    const okNoJava = r2.status === 0 && !(r2.stdout || '').trim();
    record('B11', okMatch && okNoJava, okMatch && okNoJava ? '标记匹配且有 .java 改动放行;无 .java 改动直接放行' : `匹配态 status=${r1.status} stdout=${(r1.stdout || '').slice(0, 150)};无java status=${r2.status}`);
  });

  // 内容盲区钉子①:标记后仅改"未跟踪脏 .java"的内容——status 行集不变,归一化内容哈希须使指纹漂移
  runCase('B18', () => {
    const stubDir = makeOcrStub();
    wipeState();
    const p = writeFixture(path.join('gitcase', 'Untracked.java'), CLEAN_JAVA);
    const mark = reviewMark('done');
    if (mark.status !== 0) throw new Error(`review-mark done 失败: ${mark.stderr || mark.stdout}`);
    fs.appendFileSync(p, '// after mark\n'); // 只改内容,路径级 status 不变
    const res = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('指纹不匹配');
    record('B18', ok, ok ? 'git 门 deny(未跟踪 .java 标记后仅改语义内容)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  // 内容盲区钉子②:标记后对"已跟踪已修改" .java 再改内容——status 行( M)不变,-w diff 须使指纹漂移
  runCase('B19', () => {
    const stubDir = makeOcrStub();
    wipeState();
    const p = writeFixture(path.join('gitcase', 'Tracked.java'), CLEAN_JAVA);
    const rel = path.relative(LAB, p).replace(/\\/g, '/');
    gitRun(['add', rel]);
    gitRun(['-c', 'user.email=selftest@local', '-c', 'user.name=selftest', 'commit', '-m', 'track Tracked.java']);
    fs.appendFileSync(p, '// dirty\n'); // 已跟踪已修改( M)
    const mark = reviewMark('done');
    if (mark.status !== 0) throw new Error(`review-mark done 失败: ${mark.stderr || mark.stdout}`);
    fs.appendFileSync(p, '// after mark\n'); // status 行不变,只有 diff 内容变
    const res = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('指纹不匹配');
    record('B19', ok, ok ? 'git 门 deny(已跟踪已修改 .java 标记后再改语义内容)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  // 大小写旁路:Windows 可执行名大小写不敏感,Git commit 不能绕过 git 门
  runCase('B20', () => {
    const stubDir = makeOcrStub();
    wipeState();
    writeFixture(path.join('gitcase', 'Bad.java'), BAD_JAVA);
    const res = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'Git commit --dry-run -m x' } }, stubDir);
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && (out.reason || '').includes('未经回合评审');
    record('B20', ok, ok ? 'Git(大写)commit 同样 deny,进入 git 门' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  // 语义指纹钉子:标记后对脏 .java 做纯空白改动(加缩进/空行)→ git 门仍放行。
  // 未跟踪态靠空白归一化哈希;已跟踪已修改态(B19 留下的 Tracked.java)靠 -w patch 过滤。
  // (Stop 层 GJF 回合末自动格式化重写文件不得作废指纹)
  runCase('B21', () => {
    const stubDir = makeOcrStub();
    wipeState();
    const p = writeFixture(path.join('gitcase', 'Ws.java'), CLEAN_JAVA);
    const mark = reviewMark('done');
    if (mark.status !== 0) throw new Error(`review-mark done 失败: ${mark.stderr || mark.stdout}`);
    fs.appendFileSync(p, '   \n\n'); // 未跟踪 .java:纯空白(缩进+空行),语义不变
    const r1 = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const okUntracked = r1.status === 0 && !(r1.stdout || '').trim();
    fs.appendFileSync(path.join(TMP, 'gitcase', 'Tracked.java'), '  \n'); // 已跟踪已修改 .java:纯空白追加
    const r2 = hookPath('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }, stubDir);
    const okTracked = r2.status === 0 && !(r2.stdout || '').trim();
    record('B21', okUntracked && okTracked, okUntracked && okTracked
      ? 'git 门放行(未跟踪与已跟踪已修改两态的纯空白改动均不使语义指纹漂移)'
      : `未跟踪态 status=${r1.status} stdout=${(r1.stdout || '').slice(0, 150)};跟踪态 status=${r2.status} stdout=${(r2.stdout || '').slice(0, 150)}`);
  });

  // git 用例结束,立即清掉临时 .git(finally 里还有兜底)
  if (fs.existsSync(GIT_DIR)) rmTree(GIT_DIR);
}

// ---------------------------------------------------------------- review-mark(R1-R3)

function reviewMarkCases() {
  try {
    gitInitOrFail();
  } catch (e) {
    record('R1', false, `git init 失败,R 段跳过: ${e.message}`);
    return;
  }
  try {
    runCase('R1', () => {
      wipeState();
      const res = reviewMark('status');
      const out = stdoutJson(res);
      const ok = res.status === 0 && out && out.missing === true;
      record('R1', ok, ok ? 'status 无标记时输出 {"missing":true}' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
    });

    runCase('R2', () => {
      wipeState();
      const done = reviewMark('done');
      const payload = stdoutJson(done);
      const shapeOk = done.status === 0 && payload && payload.version === 1
        && /^[0-9a-f]{32}$/.test(payload.fingerprint || '') && !isNaN(Date.parse(payload.markedAt || ''));
      const fileOk = fs.existsSync(REVIEW_MARK_FILE);
      const st = reviewMark('status');
      const roundTrip = JSON.stringify(stdoutJson(st)) === JSON.stringify(payload);
      const ok = shapeOk && fileOk && roundTrip;
      record('R2', ok, ok ? 'done 写入 {version:1,fingerprint:32hex,markedAt:ISO},status 原样往返' : `shape=${shapeOk} file=${fileOk} 往返=${roundTrip} stdout=${(done.stdout || '').slice(0, 150)}`);
    });

    runCase('R3', () => {
      wipeState();
      const fp1 = stdoutJson(reviewMark('done')).fingerprint;
      writeFixture(path.join('r3', 'extra.txt'), 'x');
      const fp2 = stdoutJson(reviewMark('done')).fingerprint;
      rmTree(path.join(TMP, 'r3'));
      const fp3 = stdoutJson(reviewMark('done')).fingerprint;
      const ok = fp1 && fp2 && fp3 && fp1 !== fp2 && fp1 === fp3;
      record('R3', ok, ok ? '指纹对工作区变化敏感(加文件变、删掉复原)' : `fp1=${fp1} fp2=${fp2} fp3=${fp3}`);
    });
  } finally {
    if (fs.existsSync(GIT_DIR)) rmTree(GIT_DIR);
  }
}

// ---------------------------------------------------------------- post-tool-use(U1-U4)

function postCases() {
  runCase('U1', () => {
    wipeState();
    const p = writeFixture(path.join('u1', 'Bad.java'), BAD_JAVA);
    const res = postOn(p);
    const lines = queueLines();
    const ok = res.status === 0 && !(res.stdout || '').trim() && !(res.stderr || '').trim()
      && lines.length === 1 && lines[0] === p.replace(/\\/g, '/');
    record('U1', ok, ok ? 'Bad.java 仅入队(不再跑任何检查),stdout 静默' : `status=${res.status} 队列=${JSON.stringify(lines)} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('U2', () => {
    wipeState();
    const p = writeFixture(path.join('u2', 'notes.md'), '# notes\n');
    const res = postOn(p);
    const ok = res.status === 0 && !(res.stdout || '').trim() && queueLines().length === 0;
    record('U2', ok, ok ? '.md 不入队、静默' : `status=${res.status} 队列=${JSON.stringify(queueLines())}`);
  });

  runCase('U3', () => {
    wipeState();
    const res = postOn(path.join(TMP, 'u3', 'target', 'Gen.java'));
    const ok = res.status === 0 && !(res.stdout || '').trim() && queueLines().length === 0;
    record('U3', ok, ok ? 'target/ 等忽略路径不入队' : `status=${res.status} 队列=${JSON.stringify(queueLines())}`);
  });

  runCase('U4', () => {
    wipeState();
    const p = writeFixture(path.join('u4', 'Bad.java'), BAD_JAVA);
    postOn(p);
    postOn(p);
    const lines = queueLines();
    const ok = lines.length === 2 && lines.every(l => l === p.replace(/\\/g, '/'));
    record('U4', ok, ok ? '重复 post 追加两行(append 语义,去重由 Stop 聚合承担)' : `队列=${JSON.stringify(lines)}`);
  });
}

// ---------------------------------------------------------------- stop(S1-S7)

function stopCases() {
  // S1/S2/S5/S6 统一用 ocr 桩 PATH:真机装没装 ocr 都不影响断言与耗时
  runCase('S1', () => {
    wipeState();
    const stubDir = makeOcrStub();
    const p = writeFixture(path.join('s1', 'LongFile.java'), LONG_JAVA);
    postOn(p); // 入队
    const res = hookPath('stop', {}, stubDir);
    const ctx = ctxOf(res);
    const maxLen = maxLineLen(p);
    const ok = res.status === 0 && maxLen <= 100 && ctx.includes('已自动格式化');
    record('S1', ok, ok ? `stop 后最长行=${maxLen}≤100,输出含"已自动格式化"` : `maxLine=${maxLen} status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('S2', () => {
    wipeState();
    const stubDir = makeOcrStub();
    const p = writeFixture(path.join('s2', 'Clean.java'), CLEAN_JAVA);
    postOn(p);
    const res = hookPath('stop', {}, stubDir);
    const ctx = ctxOf(res);
    const ok = res.status === 0 && !ctx.includes('已自动格式化');
    record('S2', ok, ok ? (ctx ? '有输出(评审提醒)但无"已自动格式化"字样' : '静默') : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('S3', () => {
    wipeState();
    const stubDir = makeOcrStub();
    const p = writeFixture(path.join('s3', 'Bad.java'), BAD_JAVA);
    postOn(p);
    const res = hookPath('stop', {}, stubDir);
    const ctx = ctxOf(res);
    const previewSaved = fs.existsSync(PREVIEW_FILE) && fs.readFileSync(PREVIEW_FILE, 'utf8').includes(OCR_STUB_LINE);
    const ok = res.status === 0 && ctx.includes('ocr delegate preview') && ctx.includes(OCR_STUB_LINE)
      && ctx.includes('review-mark.js done') && previewSaved;
    record('S3', ok, ok ? 'preview 清单注入 additionalContext 且原始输出落 ocr-preview.txt,附 review-mark 提示' : `status=${res.status} 落盘=${previewSaved} ctx=${ctx.slice(0, 200)}`);
  });

  runCase('S4', () => {
    wipeState();
    const p = writeFixture(path.join('s4', 'Bad.java'), BAD_JAVA);
    postOn(p);
    // PATH 置空 = 确定性"未安装 ocr"
    const res = hookPath('stop', {}, null);
    const ctx = ctxOf(res);
    const ok = res.status === 0 && ctx.includes('未检测到 ocr') && ctx.includes('npm install -g @alibaba-group/open-code-review');
    record('S4', ok, ok ? 'ocr 缺失时降级提示(安装命令)注入 additionalContext' : `status=${res.status} ctx=${ctx.slice(0, 200)}`);
  });

  runCase('S5', () => {
    wipeState();
    const stubDir = makeOcrStub();
    const files = [];
    for (let i = 1; i <= 31; i++) {
      files.push(writeFixture(path.join('s5', `f${String(i).padStart(2, '0')}.java`), BAD_JAVA));
    }
    // 直接入队(队列格式:每行一个正斜杠绝对路径)——本用例考察 stop 截断,不考察入队通道
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, files.map(f => f.replace(/\\/g, '/')).join('\n') + '\n');
    const res = hookPath('stop', {}, stubDir, 480000);
    const ctx = ctxOf(res);
    const ok = res.status === 0 && ctx.includes('partial') && ctx.includes('stopMaxFiles');
    record('S5', ok, ok ? '31 个文件触发 stopMaxFiles=30 截断,输出含 partial 提示' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 300)}`);
  });

  runCase('S6', () => {
    wipeState();
    const stubDir = makeOcrStub();
    const p = writeFixture(path.join('s6', 'Bad.java'), BAD_JAVA);
    postOn(p);
    if (!fs.existsSync(QUEUE_FILE)) throw new Error('前置失败:post 后队列文件应存在');
    hookPath('stop', {}, stubDir);
    const gone = !fs.existsSync(QUEUE_FILE) || !fs.readFileSync(QUEUE_FILE, 'utf8').trim();
    record('S6', gone, gone ? 'stop 后 touched-files.txt 被清空' : 'stop 后队列文件仍有内容');
  });

  runCase('S7', () => {
    wipeState();
    const res = hook('stop', {});
    const ok = res.status === 0 && !(res.stdout || '').trim() && !(res.stderr || '').trim();
    record('S7', ok, ok ? '空队列 stop:exit0 无输出' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)} stderr=${(res.stderr || '').slice(0, 150)}`);
  });
}

// ---------------------------------------------------------------- 输出协议(J1)与 warmup(W1)

function protocolAndWarmupCases() {
  runCase('J1', () => {
    wipeState();
    const stubDir = makeOcrStub();
    const p = writeFixture(path.join('j1', 'Bad.java'), BAD_JAVA);
    const r1 = postOn(p);
    const r2 = hookPath('stop', {}, stubDir);
    const p1 = protocolProblem(r1);
    const p2 = protocolProblem(r2);
    const ok = !p1 && !p2 && r1.status === 0 && r2.status === 0;
    record('J1', ok, ok ? 'post 与 stop 的 stdout 均为单个可解析 JSON 且 stderr 为空' : `post: ${p1 || 'ok'}; stop: ${p2 || 'ok'}; exit=${r1.status}/${r2.status}`);
  });

  runCase('W1', () => {
    const res = hook('warmup', {});
    const ok = res.status === 0 && /预热完成/.test(res.stdout || '');
    record('W1', ok, ok ? 'warmup 工具已就绪,秒过 exit0' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });
}

// ---------------------------------------------------------------- 主流程

function main() {
  const hadState = fs.existsSync(STATE_DIR);
  const hadGit = fs.existsSync(GIT_DIR);
  if (hadState) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.cpSync(STATE_DIR, BACKUP_DIR, { recursive: true });
    console.log(`[selftest] 已备份 .tools/hook-state -> ${path.relative(LAB, BACKUP_DIR)}`);
  } else {
    console.log('[selftest] .tools/hook-state 不存在,无需备份(结束后保持不存在)');
  }

  try {
    rmTree(TMP);
    fs.mkdirSync(TMP, { recursive: true });
    preCases();
    bashCases();
    reviewMarkCases();
    postCases();
    stopCases();
    protocolAndWarmupCases();
  } finally {
    // 恢复现场:hook-state 还原、临时 .git 删除、fixture 删除
    try {
      rmTree(STATE_DIR);
      if (hadState) fs.cpSync(BACKUP_DIR, STATE_DIR, { recursive: true });
    } catch (e) {
      console.error(`[selftest] hook-state 恢复失败: ${e.message}`);
    }
    if (!hadGit && fs.existsSync(GIT_DIR)) rmTree(GIT_DIR);
    rmTree(TMP);
  }

  const fails = results.filter(r => !r.ok);
  console.log('\n==== selftest 汇总 ====');
  console.log(`${results.length - fails.length}/${results.length} 通过`);
  if (fails.length) {
    console.log('FAIL 明细:');
    fails.forEach(f => console.log(`  ${f.id}: ${f.msg}`));
  }
  if (suspects.length) {
    console.log(`疑似误报(实际行为已如实记录,未计 FAIL): ${suspects.join(', ')}`);
  }
  process.exitCode = fails.length ? 1 : 0;
}

main();
