# 后端 AI 开发模板项目

全部可搬运资产在 `resources/`,**内容已预制:拷贝即用,无需初始化**。

## resources/ 内容

| 项 | 作用 |
|---|---|
| `.zcode/config.json` | ZCode 项目级 hook 挂载(编辑期增量质量检查,相对路径已预制好) |
| `AGENTS.md` | 新项目的全局工作约定 |
| `docs/` | 质量工具、发布流程、编码准则等知识文档 |
| `scripts/` | 质量 hook runner + 配置 + 兜底安装器 `install.js`(机制详见 [scripts/README.md](resources/scripts/README.md)) |

## 新起 Java 项目(本地/云端/git 通用)

把 `resources/` 里的**全部文件和文件夹**(包括隐藏的 `.zcode/`)拷贝/上传到新项目根目录
→ 用 ZCode 打开该目录(重开会话才会加载 hook)→ 完成。

可选预热(提前下载约 70MB 工具,之后 hook 检查不联网):`node scripts/hook-runner.js warmup`。
兜底命令(模板侧执行):`node <模板>/resources/scripts/install.js <目标项目根>`。

## 维护约定

- 误删 `resources/` 时从 git 历史恢复——它是资产唯一源。
- 维护本模板时遵守 `resources/AGENTS.md` 与 `resources/docs/KARPATHY_GUIDELINES.md`。
- 改动 `resources/` 后,先在临时项目实测"拷贝 → hook 跑通"再交付,验证产物随即删除。
