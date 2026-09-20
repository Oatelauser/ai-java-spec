# 项目级质量 hook(增量)

本项目的 AI 在编辑 `.java` 的当下自动受到质量约束,而不是等 `mvn verify` 全量门禁才发现问题。机制自包含于本项目的 `.zcode/` + `scripts/`,不依赖外部路径。

> 深入操作——**升级工具版本、下载排障与手动离线安装、切换 p3c 阿里规约、深度安全扫描**——见 [docs/QUALITY_HOOK_GUIDE.md](../docs/QUALITY_HOOK_GUIDE.md),按需加载。

## 检查什么、什么时候检查

| 检查 | 工具 | 时机 | 增量方式 |
|---|---|---|---|
| **写入前高危拦截** | 密钥/凭据正则检测(毫秒级) | 每次 Edit/Write 一个 `.java` **之前** | 命中即 deny,坏代码不落盘 |
| **命令门禁** | 防旁路检测 + PMD | 每次 Bash **之前** | 拦"Bash 直写 .java";`git commit/push` 前复查改动文件 |
| 代码规范 | PMD(默认 7.x quickstart;可切 6.55 + p3c 阿里规约) | 每次 Edit/Write 一个 `.java` 后 | 只查该文件,CLI 直调不走 Maven |
| 代码安全 | PMD `category/java/security.xml`(浅层源码检查) | 同上 | 与规范同一条链路 |
| 格式化 | google-java-format(`--aosp`,4 空格) | **回合结束(Stop)统一修复** | 回合内不重写文件,编辑缓存不失效 |
| 深度安全(可选,默认关) | 编译 + SpotBugs + FindSecBugs | 回合结束(Stop) | 只扫 `target/classes` 字节码 |

- `PreToolUse`(Edit\|Write):**确定性高危**(硬编码密钥/口令/云厂商 Key)写入前 deny 并回灌修复建议——只有这类才阻断,规范类仍走事后回灌(分级响应)。
- `PreToolUse`(Bash):拦"用 heredoc/重定向/sed -i/tee 直接写改 `.java`"的旁路,引导改用 Write/Edit 进入扫描链路;`git commit/push` 前对改动的 `.java` 跑 PMD,有未修复违规即阻断(超过 `performance.gitGateMaxFiles` 个文件时按 `failureMode` 降级)。
- `PostToolUse`(matcher `Edit|Write`):对刚写的单个 `.java` 做**只读**检查(PMD 违规秒级回灌;不重写文件)。
- `Stop`:回合末统一做两件事——格式化重写 + 聚合复查;复查经 **finding 台账**去重(同一条违规只完整回灌一次,未变化的只计数提示;修复的写入不可覆盖历史 `.tools/hook-state/findings-history.log`)。
- 违规或发生自动格式化 → 以 additionalContext 注入回灌;干净 → 静默;写入前高危与门禁命中 → deny 阻断。

## 布局与配置速查

```
.zcode/config.json        hook 挂载(项目级,不碰全局 ~/.zcode)
scripts/hook-runner.js    统一入口
scripts/hook-config.json  全部开关/版本/规则集——改配置不改代码
.tools/                   工具缓存(自动创建并写入 .gitignore)
```

`hook-config.json` 常用字段:`formatter.*`(格式化开关/版本/风格)、`convention.*`(PMD 版本与规则集)、`security.enabled`(安全检查开关)、`deepScan.enabled`(深度扫描,默认关)、`javaLanguageLevel`(PMD 解析语言级别,留空用默认)、`performance.gitGateMaxFiles`(Git 门文件上限,默认 20)、`failureMode`(`open`=检查异常时降级放行并留痕/`strict`=阻断,默认 open)、`feedback`(`important`=默认/`quiet`=只留违规压掉格式化与备注提示)。**工具 JVM 与项目 JDK 解耦**:工具只需 `JAVA_HOME`(JDK 11+)。格式化与 pom Spotless 并存的重排取舍见 `docs/CODE_QUALITY_TOOLS.md` 第 5 节。

## 常见问题

- **hook 没触发**:确认 `.zcode/config.json` 里 `hooks.enabled: true`;配置文件 hook 需要重开会话加载;执行记录可在 ZCode 日志里核对。
- **hook 是编辑期反馈,不是最终门禁**:发布/交付前的 `mvn verify` / CI 全量检查仍按 `docs/CODE_QUALITY_TOOLS.md` 执行,两者互补。
- 其余(下载、版本、代理、离线)见开头指路的手册。
