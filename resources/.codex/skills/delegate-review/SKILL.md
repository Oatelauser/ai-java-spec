---
name: delegate-review
description: OCR delegate 评审入口——评审当前工作区或分支改动并出分级报告。当用户要求"评审/review 改动、交付前全量评审、review my changes / review this branch against main",或回合内修改过 .java 文件准备收尾、提交前触发。Codex 无自定义斜杠命令,本 skill 即评审入口(可 @Delegate Review 点名)。
---

# OCR delegate 评审(Codex 入口)

Codex 没有用户自定义 slash command,本 skill 就是评审入口。评审流程的**单一事实源**是项目根的
`.claude/commands/delegate-review.md`(与其余宿主共用一份,这里不复制其正文):

1. 打开并通读 `.claude/commands/delegate-review.md`,严格按其第 0~7 步执行:前置探测(ocr 探测与降级)→ preview 定清单 → rule 取规则 → 按 mode 取 diff → 逐文件评审(覆盖率强制)→ 分级报告 → 修复 → review-mark 收尾。
2. 用户给的范围参数(`--from <ref> --to <ref>` 或 `-c <commit>`)原样透传给第 1 步的 `ocr delegate preview`,缺省评审工作区改动。
3. 第 7 步收尾命令 `node scripts/review-mark.js done` 不可省略——不执行,本轮评审不算完成,git 提交门按"未评审"处理。
