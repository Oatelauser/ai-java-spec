#!/usr/bin/env node
'use strict';

/*
 * hook-runner.js 零依赖回归套件。运行:node scripts/selftest.js
 *
 * 覆盖矩阵:
 *   pre-tool-use  P1-P11(写入前高危门)
 *   bash-gate     B1-B11(Bash 写 .java 绕过检测 / git 提交门禁)
 *   post-tool-use U1-U7(单文件增量检查 + 编辑期规则抑制)
 *   stop          S1-S7(回合聚合:格式化 / 台账去重 / FIXED / 截断 / 队列清理)
 *   协议          J1(post/stop 的 stdout 必须是单个可解析 JSON 且 stderr 为空)
 *   warmup        W1(工具已就绪时秒过)
 *
 * 约定:
 *  - 一律 spawnSync(process.execPath,[runner,mode],{input}) 传 JSON,不走 shell 拼接;
 *  - fixture 全部放 .selftest-tmp/,结束删除;测试前备份 .tools/hook-state,结束后还原;
 *  - git 用例临时 git init(hook-lab 原本无 .git),结束 rm -rf .git;
 *  - P11/B6 是"记录实际行为"用例(疑似误报):只如实记录行为,不以断言迁就,也不计 FAIL。
 *
 * fixture 内容均已对 PMD 7.27.0 quickstart+security 与 google-java-format 1.36.1(aosp)实测校准:
 *   BAD_JAVA  恰好 1 条 EmptyCatchBlock(第 7 行),且本身已符合 GJF 规范(两次 stop 行号稳定)
 *   FIXED_JAVA 修复后 PMD/GJF 双干净
 *   CLEAN_JAVA PMD/GJF 双干净
 *   LONG_JAVA  >100 列长行 + 恰好 1 条 EmptyCatchBlock
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LAB = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'hook-runner.js');
const GIT_DIR = path.join(LAB, '.git');
const TMP = path.join(LAB, '.selftest-tmp');
const STATE_DIR = path.join(LAB, '.tools', 'hook-state');
const QUEUE_FILE = path.join(STATE_DIR, 'touched-files.txt');
const LEDGER_FILE = path.join(STATE_DIR, 'findings.json');
const HISTORY_FILE = path.join(STATE_DIR, 'findings-history.log');
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
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
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

const FIXED_JAVA = [
  'package selftesttmp;',
  '',
  'public class Bad {',
  '    void run() {',
  '        try {',
  '            helper();',
  '        } catch (Exception e) {',
  '            helper();',
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

const UNUSED_IMPORT_JAVA = [
  'package selftesttmp;',
  '',
  'import java.util.regex.Pattern;',
  '',
  'public class UnusedImport {',
  '    public String build(String raw) {',
  '        return raw.trim();',
  '    }',
  '}',
].join('\n');

const UNUSED_FIELD_JAVA = [
  'package selftesttmp;',
  '',
  'public class UnusedField {',
  '    private int stash = 3;',
  '',
  '    public String build(String raw) {',
  '        return raw.trim();',
  '    }',
  '}',
].join('\n');

const UNUSED_LOCAL_JAVA = [
  'package selftesttmp;',
  '',
  'public class UnusedLocal {',
  '    public String build(String raw) {',
  '        int leftover = 9;',
  '        return raw.trim();',
  '    }',
  '}',
].join('\n');

const MIXED_JAVA = [
  'package selftesttmp;',
  '',
  'import java.util.regex.Pattern;',
  '',
  'public class Mixed {',
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
    const ghp = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // 36 位
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

// ---------------------------------------------------------------- bash-gate(B1-B11)

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

  runCase('B15', () => {
    const res = hook('bash-gate', { tool_name: 'PowerShell', tool_input: { command: 'Get-Content src/A.java | Out-File out.txt' } });
    const out = denyJson(res);
    const ok = !out && res.status === 0;
    record('B15', ok, ok ? '读 .java 写 .txt 的 PowerShell 管道不误伤(放行)' : `误伤:status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
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

  runCase('B9', () => {
    const init = spawnSync('git', ['init'], { cwd: LAB, encoding: 'utf8', timeout: 60000 });
    if (init.status !== 0) throw new Error(`git init 失败: ${init.stderr || ''}`);
    const p = writeFixture(path.join('gitcase', 'Bad.java'), BAD_JAVA);
    const res = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    const out = denyJson(res);
    const ok = !!out && out.decision === 'deny' && /EmptyCatchBlock/.test(out.reason || '');
    record('B9', ok, ok ? 'git 提交门禁 deny(PMD 检出 EmptyCatchBlock)' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('B10', () => {
    writeFixture(path.join('gitcase', 'Bad.java'), FIXED_JAVA); // 修复空 catch
    const res = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    const ok = res.status === 0 && !(res.stdout || '').trim();
    record('B10', ok, ok ? '修复后同命令放行' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('B11', () => {
    fs.rmSync(path.join(TMP, 'gitcase'), { recursive: true, force: true });
    const files = [];
    for (let i = 1; i <= 21; i++) {
      files.push(writeFixture(path.join('gitbulk', `f${String(i).padStart(2, '0')}.java`), BAD_JAVA));
    }
    const res = hook('bash-gate', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    const stderr = res.stderr || '';
    const ok = res.status === 0 && !(res.stdout || '').trim() && /partial/.test(stderr);
    record('B11', ok, ok ? `21 个改动 .java 超上限,open 模式放行(stderr 含 partial 提示)` : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)} stderr=${stderr.slice(0, 150)}`);
  });

  // git 用例结束,立即清掉临时 .git(finally 里还有兜底)
  if (fs.existsSync(GIT_DIR)) fs.rmSync(GIT_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------- post-tool-use(U1-U7)

function postCases() {
  runCase('U1', () => {
    wipeState();
    const p = writeFixture(path.join('u1', 'Bad.java'), BAD_JAVA);
    const res = postOn(p);
    const prob = protocolProblem(res);
    const ctx = ctxOf(res);
    const ok = !prob && res.status === 0 && ctx.includes('[PMD]') && ctx.includes('EmptyCatchBlock');
    record('U1', ok, ok ? '输出 PostToolUse JSON,含 [PMD] 与 EmptyCatchBlock' : `status=${res.status} ${prob || ''} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('U2', () => {
    wipeState();
    const p = writeFixture(path.join('u2', 'UnusedImport.java'), UNUSED_IMPORT_JAVA);
    const res = postOn(p);
    const prob = protocolProblem(res);
    const ctx = ctxOf(res);
    const ok = !prob && res.status === 0 && !ctx.includes('UnnecessaryImport');
    record('U2', ok, ok ? (ctx ? '有输出但未出现 UnnecessaryImport(已抑制)' : '完全静默(UnnecessaryImport 已抑制)') : `status=${res.status} ${prob || ''} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('U3', () => {
    wipeState();
    const p = writeFixture(path.join('u3', 'UnusedField.java'), UNUSED_FIELD_JAVA);
    const res = postOn(p);
    const prob = protocolProblem(res);
    const ctx = ctxOf(res);
    const ok = !prob && res.status === 0 && !ctx.includes('UnusedPrivateField');
    record('U3', ok, ok ? (ctx ? '有输出但未出现 UnusedPrivateField(已抑制)' : '完全静默(UnusedPrivateField 已抑制)') : `status=${res.status} ${prob || ''} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('U4', () => {
    wipeState();
    const p = writeFixture(path.join('u4', 'UnusedLocal.java'), UNUSED_LOCAL_JAVA);
    const res = postOn(p);
    const prob = protocolProblem(res);
    const ctx = ctxOf(res);
    const ok = !prob && res.status === 0 && !ctx.includes('UnusedLocalVariable');
    record('U4', ok, ok ? (ctx ? '有输出但未出现 UnusedLocalVariable(已抑制)' : '完全静默(UnusedLocalVariable 已抑制)') : `status=${res.status} ${prob || ''} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('U5', () => {
    wipeState();
    const p = writeFixture(path.join('u5', 'Mixed.java'), MIXED_JAVA);
    const res = postOn(p);
    const prob = protocolProblem(res);
    const ctx = ctxOf(res);
    const ok = !prob && res.status === 0 && ctx.includes('EmptyCatchBlock') && !ctx.includes('UnnecessaryImport');
    record('U5', ok, ok ? 'EmptyCatchBlock 仍报出,UnnecessaryImport 被抑制(未误伤)' : `status=${res.status} ${prob || ''} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('U6', () => {
    wipeState();
    const p = writeFixture(path.join('u6', 'notes.md'), '# notes\n');
    const res = postOn(p);
    const ok = res.status === 0 && !(res.stdout || '').trim() && !(res.stderr || '').trim();
    record('U6', ok, ok ? '.md 文件静默' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });

  runCase('U7', () => {
    wipeState();
    const p = writeFixture(path.join('u7', 'Clean.java'), CLEAN_JAVA);
    const res = postOn(p);
    const ok = res.status === 0 && !(res.stdout || '').trim() && !(res.stderr || '').trim();
    record('U7', ok, ok ? '干净文件静默 exit0' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 150)}`);
  });
}

// ---------------------------------------------------------------- stop(S1-S7)

function stopCases() {
  runCase('S1', () => {
    wipeState();
    const p = writeFixture(path.join('s1', 'LongFile.java'), LONG_JAVA);
    postOn(p); // 入队(顺带单文件检查)
    const res = hook('stop', {});
    const ctx = ctxOf(res);
    const maxLen = maxLineLen(p);
    const ok = res.status === 0 && maxLen <= 100 && ctx.includes('已自动格式化');
    record('S1', ok, ok ? `stop 后最长行=${maxLen}≤100,输出含"已自动格式化"` : `maxLine=${maxLen} status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('S2', () => {
    wipeState();
    const p = writeFixture(path.join('s2', 'Clean.java'), CLEAN_JAVA);
    postOn(p);
    const res = hook('stop', {});
    const ctx = ctxOf(res);
    const ok = res.status === 0 && !ctx.includes('已自动格式化');
    record('S2', ok, ok ? (ctx ? '有输出但无"已自动格式化"字样' : '已规范文件 stop 静默,无"已自动格式化"') : `status=${res.status} stdout=${(res.stdout || '').slice(0, 200)}`);
  });

  runCase('S3', () => {
    wipeState();
    const p = writeFixture(path.join('s3', 'Bad.java'), BAD_JAVA);
    postOn(p);
    const r1 = hook('stop', {});
    const c1 = ctxOf(r1);
    postOn(p); // 同一违规再次入队
    const r2 = hook('stop', {});
    const c2 = ctxOf(r2);
    const ok = r1.status === 0 && r2.status === 0
      && c1.includes('EmptyCatchBlock') && !c1.includes('此前已报告')
      && c2.includes('另有 1 条此前已报告');
    record('S3', ok, ok ? '第二次 stop 只提示"另有 1 条此前已报告"(台账去重生效)' : `stop1=${(r1.stdout || '').slice(0, 120)} stop2=${(r2.stdout || '').slice(0, 160)}`);
  });

  runCase('S4', () => {
    wipeState();
    const p = writeFixture(path.join('s4', 'Bad.java'), BAD_JAVA);
    postOn(p);
    hook('stop', {}); // 违规进台账
    fs.writeFileSync(p, FIXED_JAVA); // 修复空 catch
    postOn(p);
    const res = hook('stop', {});
    const hist = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, 'utf8') : '';
    let stillThere = true;
    try {
      const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
      stillThere = Object.values(ledger.findings || {}).some(f => f.rule === 'EmptyCatchBlock');
    } catch (e) {
      throw new Error(`findings.json 解析失败: ${e.message}`);
    }
    const fixedLine = (hist.split(/\r?\n/).find(l => /^FIXED /.test(l) && l.includes('EmptyCatchBlock')) || '');
    const ok = !!fixedLine && !stillThere;
    record('S4', ok, ok ? `findings-history.log 出现 FIXED 行且台账中该条消失(${fixedLine.slice(0, 100)})` : `FIXED行=${fixedLine ? '有' : '无'} 台账仍含该条=${stillThere} status=${res.status}`);
  });

  runCase('S5', () => {
    wipeState();
    const files = [];
    for (let i = 1; i <= 31; i++) {
      files.push(writeFixture(path.join('s5', `f${String(i).padStart(2, '0')}.java`), BAD_JAVA));
    }
    // 直接入队(队列格式:每行一个正斜杠绝对路径)——本用例考察 stop 截断,不考察入队通道
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(QUEUE_FILE, files.map(f => f.replace(/\\/g, '/')).join('\n') + '\n');
    const res = hook('stop', {}, 480000);
    const ctx = ctxOf(res);
    const ok = res.status === 0 && ctx.includes('partial') && ctx.includes('stopMaxFiles');
    record('S5', ok, ok ? '31 个文件触发 stopMaxFiles=30 截断,输出含 partial 提示' : `status=${res.status} stdout=${(res.stdout || '').slice(0, 300)}`);
  });

  runCase('S6', () => {
    wipeState();
    const p = writeFixture(path.join('s6', 'Bad.java'), BAD_JAVA);
    postOn(p);
    if (!fs.existsSync(QUEUE_FILE)) throw new Error('前置失败:post 后队列文件应存在');
    hook('stop', {});
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
    const p = writeFixture(path.join('j1', 'Bad.java'), BAD_JAVA);
    const r1 = postOn(p);
    const r2 = hook('stop', {});
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
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    preCases();
    bashCases();
    postCases();
    stopCases();
    protocolAndWarmupCases();
  } finally {
    // 恢复现场:hook-state 还原、临时 .git 删除、fixture 删除
    try {
      fs.rmSync(STATE_DIR, { recursive: true, force: true });
      if (hadState) fs.cpSync(BACKUP_DIR, STATE_DIR, { recursive: true });
    } catch (e) {
      console.error(`[selftest] hook-state 恢复失败: ${e.message}`);
    }
    if (!hadGit && fs.existsSync(GIT_DIR)) fs.rmSync(GIT_DIR, { recursive: true, force: true });
    fs.rmSync(TMP, { recursive: true, force: true });
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
