# 项目级质量 hook(回合级)

本项目的 AI 在写 `.java` 的当下与回合末自动受到质量约束,而不是等 `mvn verify` 全量门禁才发现问题。机制自包含于本项目的 `.zcode/` + `.claude/` + `.opencodereview/` + `scripts/`,不依赖外部路径。

> 深入操作——**OCR delegate 评审架构、规则自定义、版本锚定与降级、深度安全扫描**——见 [docs/QUALITY_HOOK_GUIDE.md](../docs/QUALITY_HOOK_GUIDE.md),按需加载。

## 检查什么、什么时候检查

| 检查 | 工具 | 时机 | 方式 |
|---|---|---|---|
| **写入前高危拦截** | 密钥/凭据正则检测(毫秒级) | 每次 Edit/Write 一个 `.java` **之前** | 命中即 deny,坏代码不落盘 |
| **命令门禁** | 防旁路检测 + 评审状态校验 | 每次 Bash/PowerShell **之前** | 拦"shell 直写 `.java`";`git commit/push` 前校验评审状态标记 |
| 规范+安全评审 | OCR delegate(宿主模型评审) | 回合末提醒 + `/delegate-review` 命令 | 规约来自 `.opencodereview/rule.json`(p3c 蒸馏)+ ocr 内置规则 |
| 格式化 | google-java-format(`--aosp`,4 空格) | **回合结束(Stop)统一修复** | 回合内不重写文件,编辑缓存不失效 |
| 深度安全(可选,默认关) | 编译 + SpotBugs + FindSecBugs | 回合结束(Stop) | 只扫 `target/classes` 字节码 |

- `PreToolUse`(Edit\|Write):**确定性高危**(硬编码密钥/口令/云厂商 Key)写入前 deny 并回灌修复建议——只有这类才阻断,其余走回合级评审(分级响应)。
- `PreToolUse`(Bash):拦"用 heredoc/重定向/sed -i/tee(及 PowerShell 的 Out-File/Set-Content/Add-Content/.NET WriteAll*)直接写改 `.java`"的旁路,引导改用 Write/Edit 进入受控链路;`git commit/push` 前做**评审状态标记校验**——改动未评审、或评审之后又有新 `.java` 改动即阻断;ocr CLI 缺失时按 `failureMode` 降级(`open` 留痕放行/`strict` 阻断)。
- `PostToolUse`(matcher `Edit|Write`):只把改动的 `.java` 记入回合队列,不做检查(省外部进程开销),检查收敛到回合级评审。
- `Stop`:回合末统一做三件事——格式化重写、(可选)深度扫描、**评审提醒**;提醒经 `ocr delegate preview` 取"该审哪些文件+用什么规则"预注入上下文(best-effort,送达依赖宿主)并落 hook-state 供 git 门比对。
- 评审执行:用 `/delegate-review` 命令(Claude Code 宿主;其它宿主照 `.claude/commands/delegate-review.md` 手动走),流程 preview → rule → 逐文件评审(覆盖率强制)→ 修复,收尾必须 `node scripts/review-mark.js done` 写评审标记。

## 布局与配置速查

```
.zcode/config.json         hook 挂载(ZCode 宿主)
.claude/settings.json      hook 挂载(Claude Code 宿主)
.claude/commands/          评审命令资产(delegate-review.md)
.opencodereview/rule.json  评审规约(产物,勿手改;源=p3c-rules.md)
scripts/hook-runner.js     统一入口
scripts/hook-config.json   全部开关/版本——改配置不改代码
scripts/review-mark.js     评审完成状态标记(git 门校验用)
scripts/build-rules.js     rule.json 生成器(改 .opencodereview/p3c-rules.md 后跑)
scripts/upgrade.js         依赖版本查新与整批升级统一入口
.tools/                    工具缓存(自动创建并写入 .gitignore)
```

`hook-config.json` 常用字段:`formatter.*`(格式化开关/版本/风格)、`deepScan.enabled`(深度扫描,默认关)、`performance.stopMaxFiles`(Stop 层评审清单上限,默认 30,超额标注 partial/INCONCLUSIVE)、`failureMode`(`open`=检查异常时降级放行并留痕/`strict`=阻断,默认 open)、`feedback`(`important`=默认/`quiet`=只留违规压掉格式化与备注提示)。**工具 JVM 与项目 JDK 解耦**:工具只需 `JAVA_HOME`(JDK 11+)。格式化与 pom Spotless 并存的重排取舍见 `docs/CODE_QUALITY_TOOLS.md` 第 5 节。

`ocr`(open-code-review)是全局 npm CLI,不在 `.tools/` 缓存内:缺失时编辑期评审降级(Stop 提示跳过、git 门按 `failureMode` 处理),安装 `npm install -g @alibaba-group/open-code-review`(要求 ≥v1.9.0,实测基线 v1.12.9)。版本查新与升级的统一入口是 `node scripts/upgrade.js`(`--check` 只查不升;`--offline <包目录>` 零网络应用离线升级包——目录内含 `manifest.json` 与工具文件,应用前逐文件校验 sha256,无包时走默认在线模式)。

## 常见问题

- **hook 没触发(按此顺序排查,ZCode 宿主)**:① 用**探针或 selftest 判定死活**——日志里的 `pending_trust` 是噪音信号(hooks 正常工作时也会刷),不能作为封锁依据;最可靠的是发一个违规写入看有无 `[quality-hook]` 回灌,或跑 `node scripts/selftest.js`(全量回归,自建自删 git 仓库与测试文件)。② **恢复手册**(hooks 确认全哑时):备份并删除 `~/.zcode/security/workspace-hook-trust-v1.json` 中本项目的记录 → 完全重启客户端(不是只开新会话) → 新会话中批准信任弹窗(4 项)——记录写入与同会话生效已被两次实证。③ 信任按 **hook 声明摘要**绑定:改 `.zcode/config.json` 的命令/事件/matcher 需重批,且**只重批变更过的声明**(实测仅 matcher 变化时只弹 2 项,未变声明沿用旧批;改 `scripts/hook-config.json` 不影响)。批准后客户端可能把 config 规范化重写(如 `timeoutMs` 毫秒改写为 `timeout` 秒),属正常勿手工改回;重拷 config 即使语义相同也可能再弹窗,批过即恢复。**信任跨会话继承(已实证)**:批准记录按工作区持久保存,新会话(不重启客户端)零弹窗、hook 直接生效,无需每会话重批。④ `hooks.enabled: true` 与配置加载。**Claude Code 宿主**:审核机制不同(无上述信任文件),排查见 docs/QUALITY_HOOK_GUIDE.md 第 6 节。
- **回合末文件被改写、却没看到"已自动格式化"提示**:Stop 的格式化动作与提示注入是两回事——ZCode 一次实测中动作生效(文件被改写、台账落盘)而提示未送达模型(详见 docs/QUALITY_HOOK_GUIDE.md 第 6 节)。回合结束后继续编辑前,先重新 Read 被改写的文件,否则 Edit 可能匹配失败。
- **ocr 相关**(缺 CLI、版本过旧不认 `--format json`、规则没生效/想自定义):见手册第 1 节。
- **hook 是编辑期反馈,不是最终门禁**:发布/交付前的 `mvn verify` 全量检查与 AI 全量评审仍按 `docs/CODE_QUALITY_TOOLS.md`、`docs/RELEASE_PROCESS.md` 执行,两者互补。
- 其余(深度扫描、工具版本与离线)见开头指路的手册。
