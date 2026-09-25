#!/usr/bin/env node
'use strict';

/*
 * rule.json 生成器:.opencodereview/p3c-rules.md 是唯一维护源,本脚本把它组装成
 * .opencodereview/rule.json(产物,勿手改)。用法:node scripts/build-rules.js
 *
 * 组装规则:
 *   - 源文件按 `## 组名` 分节;组名即生成文本里的小节标题,行前缀取组名去掉
 *     括号补注后的部分(如 `## 补充盲区(p3c 未覆盖)` → 前缀 `[补充盲区]`)。
 *   - 每条规则一行:`- [强制] 规则文本` 或 `- [建议] 规则文本`;
 *     空行/标题/说明文字忽略;规则行出现在任何 ## 之前、或分节下没有规则行,均报错退出。
 *   - 评审导语(只评审改动行等)与 exclude 骨架描述的是评审执行方式与产物结构,
 *     不是规则条目,随本生成器维护。
 *   - 幂等:生成物与现存 rule.json 逐字节一致则不写文件,只报 up-to-date。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '.opencodereview', 'p3c-rules.md');
const DEST = path.join(ROOT, '.opencodereview', 'rule.json');

// 评审导语:告诉宿主模型怎么使用这份规约(改动行聚焦/级别语义),不是规则条目
const PREAMBLE = '对本文件的改动按《阿里巴巴Java开发手册》p3c 规约评审(转译自 alibaba/p3c p3c-pmd 九组 ruleset 共 55 条,另附 6 条 p3c 未覆盖盲区)。只评审改动行(+ 行),可参考同文件近上下文作判据;信息不足判不了的,跳过该条并在报告中注明,不要猜。级别:[强制]=priority 1-2,[建议]=priority 3。';

// exclude 与条目形状是产物骨架的一部分,改这里等于改全部产物,改完重新生成即可
const EXCLUDE = ['**/target/**', '**/build/**', '**/node_modules/**', '**/.tools/**', '**/.git/**'];

try {
  main();
} catch (e) {
  console.error(`[build-rules] 失败: ${e.message}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`维护源不存在: ${SRC}(rule.json 只能由源生成,不能凭空手写)`);
  }
  const sections = parseSource(fs.readFileSync(SRC, 'utf8'));
  const total = sections.reduce((n, s) => n + s.rules.length, 0);

  const blocks = sections.map((section) => {
    const tag = section.title.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
    const lines = section.rules.map((r) => `[${tag}][${r.level}] ${r.text}`);
    return [`## ${section.title}`, ...lines].join('\n');
  });
  const rule = [PREAMBLE, '', blocks.join('\n')].join('\n');

  const output = `${JSON.stringify({
    exclude: EXCLUDE,
    rules: [{ path: '**/*.java', rule, merge_system_rule: true }],
  }, null, 2)}\n`;

  // 幂等:内容一致就不写,保住 mtime 与"未变动"信号
  const existing = fs.existsSync(DEST) ? fs.readFileSync(DEST, 'utf8') : null;
  if (existing === output) {
    console.log(`[build-rules] up-to-date: ${sections.length} 组 ${total} 条,rule 文本 ${Buffer.byteLength(rule, 'utf8')} 字节,rule.json 未变动`);
    return;
  }
  fs.writeFileSync(DEST, output);
  console.log(`[build-rules] 已生成 ${path.relative(ROOT, DEST)}: ${sections.length} 组 ${total} 条,rule 文本 ${Buffer.byteLength(rule, 'utf8')} 字节`);
}

// 解析维护源:## 分节 + `- [级别] 文本` 规则行;其余行(空行/一级标题/说明文字)忽略
function parseSource(text) {
  const sections = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], rules: [] };
      sections.push(current);
      continue;
    }
    const item = line.match(/^-\s*\[(强制|建议)\]\s+(.+?)\s*$/);
    if (!item) continue; // 空行/说明文字/其它格式:忽略
    if (!current) {
      throw new Error(`规则行出现在任何 ## 分节之前,无法归组: "${line}"`);
    }
    current.rules.push({ level: item[1], text: item[2] });
  }
  if (sections.length === 0) {
    throw new Error('维护源里没有任何 ## 分节');
  }
  const empty = sections.filter((s) => s.rules.length === 0);
  if (empty.length > 0) {
    throw new Error(`分节下没有任何规则行(删整节请连 ## 标题一起删): ${empty.map((s) => s.title).join('、')}`);
  }
  return sections;
}
