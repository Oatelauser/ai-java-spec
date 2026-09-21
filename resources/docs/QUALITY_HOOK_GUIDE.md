# 质量 hook 操作手册(本项目视角)

> 本手册全部以**当前项目**为视角:所有路径都在项目根下,现查现用。
> 本机制来自质量模板,模板仓库侧的操作与本项目无关。

## 1. 升级工具版本(以 google-java-format 为例)

**版本号只有一个登记处:本项目的 `scripts/hook-config.json`。**

1. **查可用版本**:打开 https://repo1.maven.org/maven2/com/google/googlejavaformat/google-java-format/ ,列出的目录名就是全部可选版本。
2. **改版本号**——只动 `formatter.version` 这一个字段:

   ```json
   {
     "formatter": {
       "enabled": true,
       "tool": "google-java-format",
       "version": "1.19.2",
       "style": "aosp",
       "autoFix": true
     }
   }
   ```

3. **下载新版**:项目根跑 `node scripts/hook-runner.js warmup`(不跑也行,下次检查发现缺版本会自动下载)。新版本落在 `.tools/<工具>/<新版本>/`,旧版本原样保留,想回退把版本号改回去即可。

各工具对应的字段与版本查询地址:

| 工具 | 字段(scripts/hook-config.json) | 在哪查可用版本 |
|---|---|---|
| google-java-format | `formatter.version` | https://repo1.maven.org/maven2/com/google/googlejavaformat/google-java-format/ |
| PMD | `convention.version` | https://github.com/pmd/pmd/releases |
| SpotBugs(默认关) | `deepScan.spotbugsVersion` | https://github.com/spotbugs/spotbugs/releases |
| FindSecBugs(默认关) | `deepScan.findsecbugsVersion` | https://repo1.maven.org/maven2/com/h3xstream/findsecbugs/findsecbugs-plugin/ |
| p3c 预设的 PMD | `convention.version` 固定 `6.55.0` | 不可升:p3c-pmd 2.1.1 只兼容 PMD 6 |

## 2. 下载与离线安装

- **下载时机**:`.tools/` 若随资产携带则完全免下载;否则首次检查自动下载(约 60-70MB、20 秒量级,受网络影响),之后离线复用;也可随时 `node scripts/hook-runner.js warmup` 主动预置。
- **下载透明**:`warmup`/检查下载时实时打印每个候选地址(`[download] <URL>`);失败信息列出**全部候选 URL + 精确存放路径**,照抄浏览器下载放好再重跑即跳过。
- **代理**:支持 `HTTPS_PROXY` 环境变量。
- **手动存放路径表**(项目根相对,版本号以 hook-config.json 为准):

  | 工具 | 手动存放路径(免改名,官方原文件名即可) | 官方来源 |
  |---|---|---|
  | google-java-format | `.tools/google-java-format/` 下任一:`gjf-<版本>.jar` 或原名 `google-java-format-<版本>-all-deps.jar` | Maven Central(候选地址见报错) |
  | PMD | `.tools/pmd/` 下任一:`pmd-<版本>.zip`、`pmd-dist-<版本>-bin.zip`(7.x 原名)、`pmd-bin-<版本>.zip`(6.x 原名);解压由 runner 自动完成 | GitHub Releases |
  | SpotBugs(默认关) | `.tools/spotbugs/spotbugs-<版本>.tgz` | GitHub Releases |
  | FindSecBugs 插件(默认关) | `.tools/spotbugs/spotbugs-<版本>/plugin/findsecbugs-plugin-<版本>.jar` | Maven Central |
  | p3c 预设附加 jar | `.tools/pmd/pmd-<版本>/lib/` 下放 `p3c-pmd-<版本>.jar`、`kotlin-stdlib-<版本>.jar`、`kotlin-stdlib-jdk8-<版本>.jar` | Maven Central |

- **PMD 只有 GitHub Releases 一个渠道**:受限网络可能超时(自动重试);彻底失败时可用公共 GitHub 镜像站下载 zip,再按上表路径放入,效果等同手动安装。

## 3. 切换阿里 p3c 规约

把 `scripts/hook-config.pmd6-p3c.json` 的内容覆盖到 `scripts/hook-config.json` 即可(PMD 固定 6.55.0)。**`p3cKotlinVersion` 字段别删**:p3c 含 Kotlin 实现的规则,standalone PMD 必须显式带 kotlin-stdlib,删了会报 `ClassNotFoundException: kotlin...`。

## 4. 深度安全扫描(默认关)

`hook-config.json` 里 `deepScan.enabled: true` 开启后,`Stop` 层会先 `mvn compile` 再跑 SpotBugs + FindSecBugs 扫 `target/classes` 字节码(需要 `pom.xml` 与 mvn/mvnw)。只在需要深度扫描时打开,会增加回合末耗时。

## 5. 写入前门、命令门与 finding 台账

三层防线(分级响应:只有确定性高危才阻断,规范类仍走事后回灌):

- **写入前高危门**(PreToolUse, Edit|Write):毫秒级正则检测硬编码密钥/口令/云厂商 Key(私钥内容、`password/secret/token= "..."` 赋值、AKIA/sk-/ghp_/xox* 前缀)。命中即 deny,坏代码不落盘,回灌"改用环境变量/配置中心"的修复建议。刻意不用 PMD——写入前门的性能契约是秒级的百分之一。
- **命令门**(PreToolUse, Bash)两件事:
  - 防旁路:检测 heredoc/重定向/`sed -i`/`tee` 及 PowerShell 的 `Out-File`/`Set-Content`/`Add-Content`/`.NET WriteAll*` 直接写改 `.java`,deny 并引导改用 Write/Edit 进入扫描链路;
  - Git 门:`git commit/push` 前对改动的 `.java` 跑 PMD,有未修复违规即阻断;改动文件超过 `performance.gitGateMaxFiles`(默认 20)时,`open` 模式跳过检查留痕放行、`strict` 模式拒绝。
- **finding 台账**(Stop 复查去重):同一条违规(文件+行+规则)只完整回灌一次,之后只计数提示("另有 N 条此前已报告");本轮检查过但未再出现的判定为已修复,追加到不可覆盖的 `.tools/hook-state/findings-history.log`。台账按"行号"记键,格式化导致行号漂移可能重新完整报告一次,属已知取舍。
- **编辑期容忍"未使用类"中间态**:PostToolUse 对 `UnnecessaryImport/UnusedPrivateField/UnusedLocalVariable/UnusedPrivateMethod/UnusedFormalParameter` 静默(单次编辑看不到整个回合的意图——"先加声明、下次编辑才使用"是合法节奏);Stop 全量复查兜底,回合结束时真正没人用的会被抓到。

相关配置(`scripts/hook-config.json`):`failureMode`(open/strict)、`feedback`(important/quiet)、`performance.gitGateMaxFiles`。

## 6. 接入已有代码的项目(存量工程)

机制上天然适配存量项目:**编辑期只查改动的文件**(改哪治哪,不会对全库扫违规);但接入时注意四点:

1. **AGENTS.md 不覆盖**:推送/拷贝到已有项目时,若目标已有自己的 AGENTS.md,安装器会跳过(它是项目身份文件);需要模板的质量约定请把相关条目人工合并进去。
2. **只拷核心也行**:已有约定的项目可以只拷 `.zcode/` + `scripts/`(+ `.tools/`),不带 AGENTS.md/docs。
3. **存量改动的首次噪音**:第一次编辑某个老文件时,该文件的历史遗留违规会随回灌出现(增量治理的特性而非误报);台账会去重,修不修按团队节奏。
4. **Stop 复查上限**:git 脏文件很多时,回合末复查按 `performance.stopMaxFiles`(默认 30)截断,超额部分标注 partial/INCONCLUSIVE——大仓库可调大或分批提交。**非 git 项目两张网缺一**:无 `.git` 时 git 脏文件网恒空,回合末复查只覆盖本回合经 Write/Edit/MultiEdit 触碰的文件——构建插件、代码生成器等其它途径的重写不进回合末复查(仍由 `mvn verify`/CI 收敛),建议项目 git 化。
5. **交付门禁照旧**:pom 里没配三类检查的,按 `docs/CODE_QUALITY_TOOLS.md` 在首个交付前补齐。

## 7. 已知取舍与边界

**门禁词法的已知取舍**(代码审查实测归档):
- 测试夹具/注释里的示例口令字面量会被写入前门 deny(宁误报取向);需要密钥样本时放 `src/test/resources` 等非 .java 位置,或临时 `formatter`/门禁开关调整——未来可加 `allowlistPaths` 豁免。
- 词法门禁有漏检面:`cp template.txt A.java`、`perl -pi -e`、`node -e fs.writeFileSync`、`sed --in-place`(长参)不拦——由 Stop 的 git 兜底复查与 Git 提交门收敛,风险限于回合内延迟发现。
- `sk-` 前缀正则可能误拦 ≥20 字符的普通 slug(如 `sk-frontend-registry-cache-key`);`authToken`/`db_password` 等复合名漏检(由 PMD security 层兜底)。
- Edit 模式下高危行号是 new_string 内的相对行号,与文件实际行号可能不符。
- finding 台账按"文件+行号+规则"记键:文件顶部插/删行会使旧键失效,该轮表现为一次全量重灌+误记 FIXED,下一轮自愈;中期升级为"违规行内容指纹"。
- touched-files 队列无 TTL:Stop 长期不运行时陈旧条目会累积并挤占 `stopMaxFiles` 名额。
- MultiEdit 工具的 edits[] 数组不经写入前高危检测(PostToolUse/Stop 兜底)。

## 8. 多宿主接入(ZCode 与 Claude Code)

资产自带两份宿主配置,**并存互不干扰**(各宿主只认自己的文件):`.zcode/config.json`(ZCode)与 `.claude/settings.json`(Claude Code),指向同一个 `scripts/hook-runner.js`——runner 自动识别两家的项目目录变量。

| 差异点 | ZCode | Claude Code |
|---|---|---|
| 配置位置 | `.zcode/config.json`(`hooks.enabled` 总开关) | `.claude/settings.json`(无总开关) |
| 项目目录变量 | `${ZCODE_PROJECT_DIR}` | `${CLAUDE_PROJECT_DIR}` |
| 超时单位 | `timeoutMs`(毫秒) | `timeout`(秒) |
| deny 输出形状 | `{decision:"deny",reason}` + exit 2 | `hookSpecificOutput.permissionDecision:"deny"` + exit 0(顶层 `decision` 仅收 approve/block,legacy 形状会被 schema 校验拒绝并 fail-open) |
| 首次生效/审核 | 工作区信任弹窗(见 scripts/README FAQ 的恢复手册) | Claude Code 对项目 settings 中的 hooks 有自己的确认提示,机制不同 |
| matcher 别名 | ApplyPatch→Write/Edit | 另有 MultiEdit 工具(matcher 已含);Windows 的 shell 工具名为 **PowerShell**(无 Bash 工具),命令门 matcher 已含 `Bash\|PowerShell` |

**实测状态(如实)**:ZCode 侧已实证——引擎触发、写入前 deny、PostToolUse 回灌、Stop 的动作链(格式化改写、台账写入、队列清空);**但 Stop 的 additionalContext 提示在一次实测中未注入模型上下文**(文件确被格式化改写,模型却未收到"已自动格式化"提示;单次观测,复测待做)。在结论明确前,不要把"没看到 Stop 提示"当作"文件没被改写"的信号——回合结束后继续编辑前,先重新 Read 相关文件,否则 Edit 可能匹配失败。候选对策(仅 ZCode 宿主需要;Claude Code 已实证送达,若实现须按宿主区分,避免正常送达时重复打扰):Stop 把"已自动格式化"通知写入 hook-state,由下一次 PostToolUse 在回灌开头转告,绕开 Stop 送达通道。Claude Code 侧**真机已验**(Windows,claude CLI 2.1 无头模式,PowerShell 宿主):PostToolUse 回灌逐字送达模型;Stop additionalContext 以 `hook_additional_context` 注入并**驱动模型续回合**(与 ZCode 相反,送达通道完好);曾发现两层问题并已修复:① Windows Claude Code 无 Bash 工具、shell 为 PowerShell,matcher 未含时防旁路门完全空转(`echo > x.java` 真机落盘)——matcher 增补 `PowerShell` + runner 增补 cmdlet 检测;② 复测又暴露 deny 输出为 legacy 形状,被 v2.1.278 的 schema 校验整体拒绝且 fail-open 放行(deny 分支在该宿主从未真正生效)——deny 已按宿主分派(见上表)。两修后真机复测:两种 PowerShell 旁路均被拦下、拒绝理由送达模型。另注意:PowerShell `>` 重定向写文件自带 UTF-8 BOM。

- **格式化双层取舍**:本 hook 用 google-java-format(4 空格/100 列),pom 侧 Spotless
  (palantir,120 列)与它风格不同——并存时的重排代价与两种消振办法(关
  `formatter.enabled` / Spotless 改配 googleJavaFormat AOSP)见
  `docs/CODE_QUALITY_TOOLS.md` 第 5 节。将来可选:formatter 委托项目 Spotless 的 mode
  (风格单一来源,代价是每次编辑走一次 Maven),真实项目感到痛时再实现。
- 其余边界(hook 不替代 verify/CI、工具 JVM 与项目 JDK 解耦)见 `scripts/README.md`。
