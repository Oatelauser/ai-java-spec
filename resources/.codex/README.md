# .codex/ 资产(Codex CLI 接入)

> **未真机验证**:本目录资产在无 Codex 的环境下制作,已列入交接清单;首次使用前请整目录过一遍。
> 配置形态依据官方 hooks 文档(developers.openai.com/codex/hooks,2026-09 查证)。
> Codex 首次加载须经过 `/hooks` 信任审阅(见下),否则 hooks 完全不生效。

## 清单

- `hooks.json`——PreToolUse(`apply_patch` 写入前密钥检查 + `Bash` 命令门)/ PostToolUse / Stop 三事件,全部指向 `scripts/hook-runner.js`(与 `.zcode/`、`.claude/` 共用同一 runner;Codex 不设项目目录变量,runner 回退到脚本自身定位,宿主无关)。
- `skills/delegate-review/SKILL.md`——评审入口(Codex 无自定义 slash command,skill 即入口),薄引用项目根 `.claude/commands/delegate-review.md`,不复制正文。

## 首次启用(一次性,是"拷贝即生效"的已知例外)

1. 用 Codex 打开本项目,项目须处于 trusted 状态(项目级 `.codex/` 层仅在 trusted 项目加载)。
2. 首次启动会弹 "Hooks need review" 拦截面板:在 Codex 内执行 `/hooks`,逐条审阅并信任本目录的 hooks(基于 hash,一次性;`hooks.json` 内容变更后需重审)。

## 已知差异(相对 `.zcode/` / `.claude/` 接线)

- 命令路径用 `$(git rev-parse --show-toplevel)` 解析:官方文档提示 Codex 可能从子目录启动,相对路径会失效(代价:非 git 项目该解析失败,hook 不生效)。
- 超时字段名为 `timeout`(秒),以官方文档为准。
- 深度说明与缺口声明见项目根 `docs/QUALITY_HOOK_GUIDE.md` 第 6 章。
