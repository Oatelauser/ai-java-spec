# 后端 AI 开发模板项目

## 项目介绍

给 Java 后端项目预置一整套 AI 编码质量约束的模板。

- **AI 写 Java 当场受约束**:写入前拦密钥、回合末自动格式化、AI 按阿里 p3c 规约评审——不等 `mvn verify` 才发现问题
- **评审走宿主模型,零 API key**:ocr delegate 模式,复用你正在用的 AI,不额外花钱
- **一套资产通吃三个宿主**:ZCode / Claude Code / Codex
- **拷贝即用**:工具缓存随包带走,新项目断网也能格式化

本 README 写给模板仓库本身,用的是 `resources/` 路径;真正带进新项目的是 `resources/` 里的文档。

## 环境准备

| 依赖 | 用途 | 安装 |
|---|---|---|
| Node.js(LTS,自带 npm) | 跑 install / hook-runner / upgrade 等脚本 | [nodejs.org](https://nodejs.org) 下载 LTS 安装,终端 `node -v` 有版本号即成功 |
| JDK 11+(设 `JAVA_HOME`) | 给 google-java-format 等工具当运行时 | 装 JDK 后把 `JAVA_HOME` 指向它的目录;新项目自己要的 JDK 版本以项目为准 |
| ocr(open-code-review) | AI 评审的核心 CLI,全局 npm 包,**不随模板拷贝,必须单独装** | `npm install -g @alibaba-group/open-code-review`(≥v1.9.0) |
| Git | 模板仓库、新项目的 git 门禁 | [git-scm.com](https://git-scm.com) 下载安装 |
| ZCode / Claude Code / Codex 任一 | 承载 hook 与评审命令 | 在用任一即可;Codex 首启要在 `/hooks` 逐条信任(仅一次) |

google-java-format、SpotBugs 这些大工具不用手动装,`install.js` 会自动下载到 `.tools/`(约 4MB)。ocr 装完可跑 `node resources/scripts/upgrade.js --check` 确认版本达标。

## 快速入门

**1. 预置**(下载工具到 `resources/.tools/`,让 resources/ 完全自包含):

```bash
node resources/scripts/install.js
```

**2. 拷进新项目**,二选一:

- 把 `resources/` 里的全部文件和文件夹(含隐藏的 `.zcode/`、`.claude/`、`.codex/`、`.opencodereview/`、`.tools/`)拷到新项目根目录;
- 或推送:`node resources/scripts/install.js <目标项目根>`。

拷的是 `resources/` 的内容,不是这个目录——新项目根直接出现 `AGENTS.md`、`scripts/` 等,没有 `resources/` 这一层。

**3. 用任一宿主打开新项目**,重开会话后 hook 生效。ZCode / Claude Code 直接用;Codex 首启需在 `/hooks` 逐条信任(见 `resources/.codex/README.md`)。

install.js 的安全阀:所在目录缺资产标记、目标是模板根、或从已部署项目发起推送时,拒绝执行;目标已有自己的 `AGENTS.md` / `CLAUDE.md` 时跳过不覆盖,要合并请手工来。

## 文件结构

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

## 运维与维护

**升级工具版本**(模板侧):

```bash
node resources/scripts/upgrade.js           # 升级:ocr → 重生成 rule.json → selftest 回归 → 冒烟,失败给回退命令
node resources/scripts/upgrade.js --check   # 只查不升:ocr / google-java-format / SpotBugs 版本对比表
```

- 新项目侧同理:`node scripts/upgrade.js`。
- 升 `.tools/` 内工具:改 `resources/scripts/hook-config.json` 对应版本字段,重跑 `install.js` 下载新版,旧版保留可回退;ocr 的回归锚点在同文件 `ocr.baseline`,升级全绿后更新。
- GitHub CI 每周自动查新,发现落后会开 issue 提醒(workflow 在 `.github/workflows/version-watch.yml`,模板侧资产,不随拷贝传导)。
- 离线升级:查新的同一 CI 运行会把工具打包成 Artifacts(`dep-bundle-<运行号>`,留 90 天,issue 里有下载入口)。本地下载解压后 `node resources/scripts/upgrade.js --offline <解压目录>` 零网络应用,逐文件 sha256 校验;打包失败就回退在线升级。

**维护约定**:

- 误删 `resources/` 从 git 历史恢复——它是资产唯一源。
- 维护模板遵守 `resources/AGENTS.md` 与 `resources/docs/KARPATHY_GUIDELINES.md`。
- 改动 `resources/` 后,先在临时项目实测"拷贝 → hook 跑通"再交付,验证产物随即删除(`resources/.tools/` 是资产,保留)。
