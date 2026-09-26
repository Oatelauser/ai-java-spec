# 后端 AI 开发模板项目

全部可搬运资产在 `resources/`,**内容已预制:拷贝即用,无需初始化**。以下全部是**模板侧操作**(根 README 不随拷贝传导,可以放心使用 `resources/` 路径;传导到新项目里的文档均为项目内视角)。

## resources/ 内容

| 项 | 作用 |
|---|---|
| `.zcode/config.json` | ZCode 项目级 hook 挂载(编辑期增量质量检查,相对路径已预制好) |
| `.claude/settings.json` + `commands/delegate-review.md` | Claude Code 项目级 hook 挂载 + `/delegate-review` 评审命令(与 ZCode 挂载同一 runner,多宿主并存互不干扰) |
| `.codex/` | Codex 宿主 hook(`hooks.json`)+ 评审 skill(**资产已备,未真机验证**,首启须在 Codex 内 `/hooks` 逐条信任) |
| `.opencodereview/` | 评审规约:`p3c-rules.md`(维护源)+ `rule.json`(生成物,勿手改) |
| `CLAUDE.md` | Claude Code 入口(薄引用 `@AGENTS.md`,全部约定在 AGENTS.md) |
| `AGENTS.md` | 新项目的全局工作约定 |
| `docs/` | 知识文档(质量工具手册、hook 操作手册、发布流程、编码准则等) |
| `scripts/` | hook-runner.js + 配置 + install / selftest / build-rules / upgrade 脚本 |
| `.tools/` | 工具缓存(现仅 google-java-format,约 4MB;由 install.js 预置生成,随拷贝带走后新项目免下载) |

## 使用流程

**1. 一次性预置**(下载约 4MB 工具到 `resources/.tools/`,让 resources/ 完全自包含):

```bash
node resources/scripts/install.js
```

**2. 传导到新项目**,二选一:

- 手动把 `resources/` 里的**全部文件和文件夹**(包括隐藏的 `.zcode/`、`.claude/`、`.codex/`、`.opencodereview/`、`.tools/`)拷贝/上传到新项目根目录;
- 或一条命令推送:`node resources/scripts/install.js <目标项目根>`。

**3. 用任一宿主打开新项目目录即生效**(重开会话才会加载 hook):

- **ZCode / Claude Code**:直接打开即可(hook 与评审命令随包生效);
- **Codex**:首启须在 Codex 内 `/hooks` 逐条审阅信任(一次性,详见 `resources/.codex/README.md`)。

> 关键语义:传导的是 resources/ 的**内容**,不是 resources/ 这个目录——新项目根直接出现 `.zcode/`、`.claude/`、`.codex/`、`.opencodereview/`、`AGENTS.md`、`CLAUDE.md`、`docs/`、`scripts/`、`.tools/`,不应有 `resources/` 这一层。

install.js 安全阀:所在目录缺资产标记、目标是模板根、或从已部署项目根发起推送时,拒绝执行;目标已有自己的 `AGENTS.md` / `CLAUDE.md` 时跳过不覆盖(项目身份文件,如需模板约定请人工合并)。

## 整批升级工具版本(模板侧)

统一入口——升 ocr(npm 全局)→ 重生成 rule.json → selftest 回归 → `ocr delegate preview` 冒烟,任一步失败醒目输出回退命令:

```bash
node resources/scripts/upgrade.js           # 执行升级(会动全局 npm 包,失败给回退命令)
node resources/scripts/upgrade.js --check   # 只查不升:ocr / google-java-format / SpotBugs 版本对比表
```

- 目标项目侧同理:`node scripts/upgrade.js`(升的是该项目环境)。
- `.tools/` 内工具(google-java-format 等)版本改 `resources/scripts/hook-config.json` 对应字段后,重跑 `node resources/scripts/install.js` 下载新版(旧版保留可回退);ocr 的实测回归锚点登记在同文件 `ocr.baseline`,升级全绿后更新它。
- GitHub CI 每周自动查新并开 issue 提醒(「依赖版本更新提醒」;workflow 在 `.github/workflows/version-watch.yml`,模板侧资产,不随拷贝传导)。
- **离线升级通道**:查新发现落后项时,同一 CI 运行会打包上传 Artifacts(`dep-bundle-<run号>`,留 90 天;issue 里附本运行的下载入口)。本地下载解压后 `node resources/scripts/upgrade.js --offline <解压目录>` 零网络应用——ocr 以主包+平台包(win32-x64)双 tgz 本地 `npm i -g`(postinstall 见平台包二进制即不触网)、google-java-format/SpotBugs 直接落位 `.tools/`,sha256 逐文件校验;回归与 baseline 更新仍按上面在线流程走,离线通道只免下载。打包失败(运行红、无 Artifacts)时回退在线通道。

## 维护约定

- 误删 `resources/` 时从 git 历史恢复——它是资产唯一源。
- 维护本模板时遵守 `resources/AGENTS.md` 与 `resources/docs/KARPATHY_GUIDELINES.md`。
- 改动 `resources/` 后,先在临时项目实测"拷贝 → hook 跑通"再交付,验证产物随即删除(预置的 `resources/.tools/` 属资产一部分,保留)。
