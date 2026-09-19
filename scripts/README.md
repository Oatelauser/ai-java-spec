# 项目级质量 hook(增量)

让"基于本模板新起的 Java 项目"在 **AI 编辑代码的当下** 就受到质量约束,而不是等 `mvn verify` 全量门禁才发现问题。

## 检查什么、什么时候检查

| 检查 | 工具 | 时机 | 增量方式 |
|---|---|---|---|
| 格式化 | google-java-format(`--aosp`,4 空格) | 每次 Edit/Write 一个 `.java` 后 | 只查该文件;违规可**自动修复** |
| 代码规范 | PMD(默认 7.x quickstart;可切 6.55 + p3c 阿里规约) | 同上 | 只查该文件,CLI 直调不走 Maven |
| 代码安全 | PMD `category/java/security.xml`(浅层源码检查) | 同上 | 与规范同一条链路 |
| 深度安全(可选,默认关) | 编译 + SpotBugs + FindSecBugs | 回合结束(Stop) | 只扫 `target/classes` 字节码 |

- `PostToolUse`(matcher `Edit|Write`):对刚写的单个 `.java` 秒级检查(通常 1-2 秒)。
- `Stop`:聚合本回合 touched files 去重复查,兜住 Bash 重定向写文件等绕过 `PostToolUse` 的路径。
- 违规或发生自动格式化 → exit 2 回灌给 agent 当场修复;干净 → 静默。

## 组成

```
.zcode/config.json          ZCode hook 挂载(项目级,不碰全局 ~/.zcode)
scripts/hook-runner.js      统一入口(node,零第三方依赖)
scripts/hook-config.json    所有开关/版本/规则集 —— 换工具版本只改这里
scripts/hook-config.pmd6-p3c.json  阿里 p3c 规约预设(想严格对齐阿里手册时复制覆盖)
scripts/init-java-project.sh       把上述资产安装到新项目
.tools/                     工具下载缓存(git ignore,首次运行自动创建)
```

## 新项目如何获得约束

```bash
bash <模板>/scripts/init-java-project.sh /path/to/新项目
# 推荐立刻预热:提前把工具下载到 .tools/,之后 hook 检查不再联网、首跑不卡
cd /path/to/新项目 && node scripts/hook-runner.js warmup
# 然后用 ZCode 打开新项目目录即可;或手动复制 .zcode/ + scripts/ 两个目录
```

脚本通过 `${ZCODE_PROJECT_DIR}` 相对寻址,复制到任何目录都能用。

## 配置说明(scripts/hook-config.json)

- `javaLanguageLevel`:留空用 PMD 默认;设 `"17"`/`"21"` 等则传 `--use-version java-<级别>`,让 PMD 按指定语言级别解析——**工具 JVM 与项目 JDK 版本是解耦的**,工具只需要一个 JDK 11+ 的 `JAVA_HOME`。
- `formatter.style`:`aosp`(4 空格)/`google`(2 空格)。注意 google-java-format 风格固定,列宽 100,与阿里手册的 120 列不同,属已知取舍。
- `convention.p3cVersion`:仅 PMD6 预设使用(p3c 2.1.1 与 PMD7 不兼容)。
- `deepScan.enabled`:开启后 Stop 层会先 `mvn compile` 再跑 SpotBugs,只在需要深度字节码安全扫描时打开。

## 环境要求与常见问题

- **JDK 11+ 的 `JAVA_HOME`**:工具运行用,与项目编译用的 JDK 无关。runner 需要 Node ≥ 14.14(ZCode 自带,通常无需关注)。
- **首次运行需联网**:自动从 Maven Central / GitHub Releases 下载 google-java-format 与 PMD 到 `.tools/`,约 60-70MB、20 秒量级;之后离线复用,单文件检查 3-5 秒。
- **PMD 下载失败**:PMD 的 CLI 发行包**只有 GitHub Releases 一个渠道**(Maven Central 上没有),受限网络下可能超时。runner 会自动重试并支持 `HTTPS_PROXY` 代理;仍失败时走离线通道——手动下载对应 zip(7.x 叫 `pmd-dist-<版本>-bin.zip`,6.x 叫 `pmd-bin-<版本>.zip`)放到 `.tools/pmd/pmd-<版本>.zip`,runner 检测到文件存在即跳过下载直接解压。
- **切 p3c 预设后报 `ClassNotFoundException: kotlin...`**:p3c 含 Kotlin 实现的规则,standalone PMD 必须同时带 kotlin-stdlib;`hook-config.pmd6-p3c.json` 里的 `p3cKotlinVersion` 就是干这个的,别删。
- **hook 没触发**:确认 `.zcode/config.json` 里 `hooks.enabled: true`;配置文件 hook 需要重开会话加载;执行记录可在 ZCode 日志里核对。
- **hook 是编辑期反馈,不是最终门禁**:发布/交付前的 `mvn verify` / CI 全量检查仍按 `docs/CODE_QUALITY_TOOLS.md` 执行,两者互补。
