# 后端 AI 开发模板项目

全部可搬运资产在 `resources/`,**内容已预制:拷贝即用,无需初始化**。以下全部是**模板侧操作**(根 README 不随拷贝传导,可以放心使用 `resources/` 路径;传导到新项目里的文档均为项目内视角)。

## resources/ 内容

| 项 | 作用 |
|---|---|
| `.zcode/config.json` | ZCode 项目级 hook 挂载(编辑期增量质量检查,相对路径已预制好) |
| `.claude/settings.json` | Claude Code 项目级 hook 挂载(同一 runner,双宿主并存互不干扰) |
| `AGENTS.md` | 新项目的全局工作约定 |
| `docs/` | 知识文档(质量工具手册、hook 操作手册、发布流程、编码准则等) |
| `scripts/` | hook-runner.js + 配置 + install.js |
| `.tools/` | 工具缓存(由 install.js 预置生成,随拷贝带走后新项目免下载) |

## 使用流程

**1. 一次性预置**(下载约 70MB 工具到 `resources/.tools/`,让 resources/ 完全自包含):

```bash
node resources/scripts/install.js
```

**2. 传导到新项目**,二选一:

- 手动把 `resources/` 里的**全部文件和文件夹**(包括隐藏的 `.zcode/` 和 `.tools/`)拷贝/上传到新项目根目录;
- 或一条命令推送:`node resources/scripts/install.js <目标项目根>`。

**3. 用 ZCode 打开新项目目录**(重开会话才会加载 hook)即生效。

> 关键语义:传导的是 resources/ 的**内容**,不是 resources/ 这个目录——新项目根直接出现 `.zcode/`、`AGENTS.md`、`docs/`、`scripts/`、`.tools/`,不应有 `resources/` 这一层。

install.js 安全阀:所在目录缺资产标记、目标是模板根、或从已部署项目根发起推送时,拒绝执行。

## 整批升级工具版本(模板侧)

1. 改 `resources/scripts/hook-config.json` 的版本字段(字段对照与版本查询地址见 [resources/docs/QUALITY_HOOK_GUIDE.md](resources/docs/QUALITY_HOOK_GUIDE.md) 第 1 节)。
2. 模板目录重跑 `node resources/scripts/install.js`,自动下载新版本到 `resources/.tools/`(旧版本保留可回退,不需要可手动删)。
3. 重新传导到各项目。已部署项目也可单独升级(改它自己的 `scripts/hook-config.json` 后跑 `node scripts/hook-runner.js warmup`),细节见手册。

## 维护约定

- 误删 `resources/` 时从 git 历史恢复——它是资产唯一源。
- 维护本模板时遵守 `resources/AGENTS.md` 与 `resources/docs/KARPATHY_GUIDELINES.md`。
- 改动 `resources/` 后,先在临时项目实测"拷贝 → hook 跑通"再交付,验证产物随即删除(预置的 `resources/.tools/` 属资产一部分,保留)。
