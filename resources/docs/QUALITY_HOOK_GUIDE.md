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
  - 防旁路:检测 heredoc/重定向/`sed -i`/`tee` 直接写改 `.java`,deny 并引导改用 Write/Edit 进入扫描链路;
  - Git 门:`git commit/push` 前对改动的 `.java` 跑 PMD,有未修复违规即阻断;改动文件超过 `performance.gitGateMaxFiles`(默认 20)时,`open` 模式跳过检查留痕放行、`strict` 模式拒绝。
- **finding 台账**(Stop 复查去重):同一条违规(文件+行+规则)只完整回灌一次,之后只计数提示("另有 N 条此前已报告");本轮检查过但未再出现的判定为已修复,追加到不可覆盖的 `.tools/hook-state/findings-history.log`。台账按"行号"记键,格式化导致行号漂移可能重新完整报告一次,属已知取舍。

相关配置(`scripts/hook-config.json`):`failureMode`(open/strict)、`feedback`(important/quiet)、`performance.gitGateMaxFiles`。

## 6. 已知取舍与边界

- **格式化双层取舍**:本 hook 用 google-java-format(4 空格/100 列),pom 侧 Spotless
  (palantir,120 列)与它风格不同——并存时的重排代价与两种消振办法(关
  `formatter.enabled` / Spotless 改配 googleJavaFormat AOSP)见
  `docs/CODE_QUALITY_TOOLS.md` 第 5 节。将来可选:formatter 委托项目 Spotless 的 mode
  (风格单一来源,代价是每次编辑走一次 Maven),真实项目感到痛时再实现。
- 其余边界(hook 不替代 verify/CI、工具 JVM 与项目 JDK 解耦)见 `scripts/README.md`。
