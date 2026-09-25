---
description: OCR delegate 评审——ocr 出文件清单与规则,宿主模型逐文件评审并出分级报告
argument-hint: [可选范围:--from <ref> --to <ref> 或 -c <commit>;缺省评审工作区改动]
---

# 回合级 OCR delegate 评审

分工:`ocr`(open-code-review)只做确定性工程——该审哪些文件、用什么规则;**评审本身由你(宿主模型)完成**,不调外部 LLM、不需要 API key。规约来自项目根 `.opencodereview/rule.json`(阿里 p3c 蒸馏)与 ocr 内置语言规则,合并生效。

## 第 0 步:前置探测(不安装、不阻断)

先跑 `ocr --version`:

- **命令不存在**:向用户打印安装指引 `npm install -g @alibaba-group/open-code-review`(Windows 备选:`irm https://open-codereview.ai/install.ps1 | iex`),**严禁自动安装**;但**不阻断会话**——走降级流程:评审清单用 `git status --porcelain` 与 `git diff --name-only HEAD` 自取,规则直接读 `.opencodereview/rule.json`,继续完成第 3 步起的评审,报告中注明"ocr 未安装,清单自取"。
- **版本低于 v1.9.0**(报 `unknown flag: --format`):后续命令去掉 `--format json` 用文本输出完成全程;不要把文本输出硬当 JSON 解析、不要虚构字段。
- 正常(v1.9.0+,当前实测基线 v1.12.9):全程统一带 `--format json`。

## 第 1 步:preview——确定评审清单

```bash
ocr delegate preview --format json $ARGUMENTS
```

用户参数(`--from <ref> --to <ref>` 或 `-c <hash>`)原样透传;缺省为工作区模式(staged + unstaged + untracked)。

从 stdout JSON 记下:`mode`、`merge_base`(range 模式构造 diff 用)、`reviewable_files`(评审清单:path/status/增删行数)、`excluded_files`(带排除原因,不评审)。workspace 模式不输出 merge_base,缺该字段属正常,仅 range 模式有。

**清单超过 12 个文件时分批评审**:按规则组或目录聚成每批不超过 12 个文件,每批独立走完第 3~5 步,全部批次完成后再汇总报告与收尾。不得为省事只评审其中一部分。

## 第 2 步:rule——取评审规则

```bash
ocr delegate rule --format json <path1> <path2> ...
```

传入第 1 步的 reviewable 路径(可分批调用)。输出按规则内容分组:同组文件共用一份评审 checklist(内置 java 规则 + 项目规约)。

## 第 3 步:取 diff

按 preview 返回的 mode:

| mode | diff 命令 |
|---|---|
| range | `git diff <merge_base>..<to> -- <path>` |
| commit | `git show <commit> -- <path>` |
| workspace | `git diff HEAD -- <path>`;untracked 新文件直接读全文(整文件都是新代码) |

## 第 4 步:逐文件评审(覆盖率强制)

- checklist 条目身份用 `(path, status)`:workspace 模式同一路径可能出现两次(staged 删除 + untracked 重建)。
- 每个文件:取 diff(只评审改动行,即 + 行)+ 其规则组 checklist 当评审依据;需要上下文时读整个文件。
- 发现第一个高危问题**不许停**,继续走完清单。
- 每个条目最终必须落到 `reviewed` 或 `skipped`(带具体理由,如"生成物/二进制/信息不足")——静默漏掉文件即违反覆盖率要求。

## 第 5 步:报告

每条发现按官方 delegate 字段约定组织:

| 字段 | 必填 | 说明 |
|---|---|---|
| path | 是 | 文件相对路径 |
| content | 是 | 问题描述与修复建议 |
| start_line / end_line | 否 | 新文件中的行号 |
| category | 否 | bug / security / performance / maintainability / test / style / documentation / other |
| severity | 否 | critical / high / medium / low |

分级纪律:Critical/High 必报;Medium 带上下文报;**Low 默认丢弃**(疑似误报、吹毛求疵),确有价值才保留;疑似误报静默丢弃。按文末模板输出。

## 第 6 步:修复

- Critical/High:安全且改动明确的直接修复,修复后对修复 diff 复评一遍。
- Medium:无需人工介入的(如提取常量、判空补卫)直接修复并复验;需业务决策的写清方案列出等人工,不硬改。
- Low 跳过。

## 第 7 步:收尾(必须执行,不可省略)

```bash
node scripts/review-mark.js done
```

该脚本写入评审状态标记(含当轮**语义指纹**——忽略空白差异的变更内容指纹),git 提交门以此校验"改动已评审":评审之后又有语义层面的 `.java` 改动(文件增删或内容修改),标记即失效,提交前需重新评审;纯格式化/空白改写(如回合末自动格式化)不影响指纹,无需重评。**不执行这一步,本轮评审不算完成。**

## 输出模板

```markdown
## 评审报告(OCR delegate)

- 范围:<mode 与 refs,或"工作区">
- 覆盖:total_files N / reviewed N / skipped M(coverage_rate X%)
- 发现:X critical, Y high, Z medium(low 已过滤,保留 L 条)

### Critical

- **`path/to/File.java:42`** [security] — 问题一句话
  > 修复:怎么改

### High

- **`path/to/File.java:26`** [bug] — 问题一句话
  > 修复:怎么改

### Medium

- **`path/to/File.java:88`** [performance] — 问题一句话
  > 修复:怎么改(如适用)

### skipped(带理由)

- `path/to/Generated.java` — 生成物,不在评审范围
```

无 critical/high/medium 发现时明确写:"评审完成——N 个文件未发现 critical/high/medium 问题。"
