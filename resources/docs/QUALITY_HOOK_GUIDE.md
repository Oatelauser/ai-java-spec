# 质量 hook 操作手册(本项目视角)

> 本手册全部以**当前项目**为视角:所有路径都在项目根下,现查现用。
> 本机制来自质量模板,模板仓库侧的操作与本项目无关。

## 1. OCR delegate 评审(编辑期规范与安全检查)

### 架构

编辑期规范/安全检查由"本地静态分析工具"改为**宿主模型评审 + `ocr` CLI 确定性分工**(delegate 模式):

| 环节 | 谁执行 | 说明 |
|---|---|---|
| 文件筛选(该审哪些) | `ocr delegate preview` | 基于 git diff 的多门过滤(二进制/敏感路径/用户 exclude/扩展名/内置默认排除),stdout 输出 JSON |
| 规则解析(用什么标准) | `ocr delegate rule` | 内置语言规则(java 安全/质量规则)+ 项目根 `.opencodereview/rule.json`(p3c 蒸馏规约),按文件分组输出 |
| 评审本身 | 宿主 AI 模型 | 拿 diff + 规则 checklist 逐文件评审,产出分级发现并修复 |
| 状态落地 | `node scripts/review-mark.js done` | 评审完成时写状态标记(含 diff 指纹),git 提交门据此校验 |

delegate 模式下 `ocr` 端**零 LLM 调用、零 API key**——它只出清单与规则,评审智能全部来自宿主模型。对环境的硬要求只有两个:`ocr` 在 PATH 上 + 当前目录是 git 仓库。

### 命令用法

- **Claude Code 宿主**:斜杠命令 `/delegate-review`(资产在 `.claude/commands/delegate-review.md`)。流程:preview(取清单)→ rule(取规则)→ 逐文件评审(覆盖率强制,每个文件必须落到 reviewed 或带理由的 skipped)→ 修复 → 收尾执行 `node scripts/review-mark.js done`。清单超过 12 个文件自动指引分批评审。
- **其它宿主/手动**:`ocr delegate` 只有 preview 与 rule 两个子命令,照 `.claude/commands/delegate-review.md` 的步骤手动执行即可,无任何宿主绑定。
- **交付前全量评审**:同一套流程传范围参数(`ocr delegate preview --format json --from <上一版本 tag> --to HEAD`),只审两版本之间的 diff——与 pom 检查同界,不做全库扫描。
- **`ocr` 缺失时**:命令只打印安装指引(`npm install -g @alibaba-group/open-code-review`),不自动安装、不阻断会话——降级为"git 自取清单 + 直读 rule.json 规则"继续评审;hook 侧的降级语义见本节末尾。

### rule.json 自定义

项目级评审规约在项目根 `.opencodereview/rule.json`(可提交入库):

```json
{
  "exclude": ["**/target/**"],
  "rules": [
    { "path": "**/*.java", "rule": "……规约文本(markdown)……", "merge_system_rule": true }
  ]
}
```

- `exclude`:不参与评审的 glob(生成物目录等);`include` 可把被内置默认排除的文件捞回来(如测试代码)。
- `rules`:按声明顺序求值,**第一个 `path` 命中的条目独占生效**。要给 `.java` 增删规约,改同一条目里的 `rule` 文本;再加一条相同 path 的条目不会生效。
- `merge_system_rule: true`:保留 ocr 内置语言规则(含安全项),项目规约与之**合并**;false(默认)= 项目规约整段替换内置规则。
- glob 匹配不区分大小写;`ocr rules check <文件路径>` 可查某文件实际命中哪条规则、来自哪一层。

### 版本锚定与降级语义

- 实测基线 **v1.12.9**;`--format json` 需 **≥v1.9.0**。旧版报 `unknown flag: --format` 时,去掉该 flag 用文本输出继续,不要把文本硬当 JSON 解析。
- `ocr` 是年轻上游;本机制是薄集成——只依赖 preview/rule 的 stdout 契约,升级 ocr 大版本后先跑一次 `ocr delegate preview` 冒烟即可。
- **未装 ocr 的降级**:编辑期 hook 照记改动队列,Stop 提示"未检测到 ocr,编辑期评审跳过";git 门 `open` 模式留痕放行 / `strict` 模式阻断;交付前 pom 三类检查兜底不变。

## 2. 深度安全扫描(默认关)

`hook-config.json` 里 `deepScan.enabled: true` 开启后,`Stop` 层会先 `mvn compile` 再跑 SpotBugs + FindSecBugs 扫 `target/classes` 字节码(需要 `pom.xml` 与 mvn/mvnw)。只在需要深度扫描时打开,会增加回合末耗时。

### 工具版本与手动离线(格式化与深度扫描工具)

版本号唯一登记处是 `scripts/hook-config.json`;`node scripts/hook-runner.js warmup` 主动预置下载,失败信息会列出全部候选 URL 与精确存放路径(支持 `HTTPS_PROXY`),照抄浏览器下载放好再重跑即跳过。

| 工具 | 字段(hook-config.json) | 在哪查可用版本 | 手动存放路径(免改名) |
|---|---|---|---|
| google-java-format | `formatter.version` | Maven Central | `.tools/google-java-format/` 下 `gjf-<版本>.jar` 或官方原名 jar |
| SpotBugs(默认关) | `deepScan.spotbugsVersion` | GitHub Releases | `.tools/spotbugs/spotbugs-<版本>.tgz` |
| FindSecBugs 插件(默认关) | `deepScan.findsecbugsVersion` | Maven Central | `.tools/spotbugs/spotbugs-<版本>/plugin/findsecbugs-plugin-<版本>.jar` |

## 3. 写入前门、命令门与评审状态标记

三层防线(分级响应:只有确定性高危才阻断,评审类靠状态标记与流程收口):

- **写入前高危门**(PreToolUse, Edit|Write):毫秒级正则检测硬编码密钥/口令/云厂商 Key(私钥内容、`password/secret/token= "..."` 赋值、AKIA/sk-/ghp_/xox* 前缀)。命中即 deny,坏代码不落盘,回灌"改用环境变量/配置中心"的修复建议。
- **命令门**(PreToolUse, Bash)两件事:
  - 防旁路:检测 heredoc/重定向/`sed -i`/`tee` 及 PowerShell 的 `Out-File`/`Set-Content`/`Add-Content`/`.NET WriteAll*` 直接写改 `.java`,deny 并引导改用 Write/Edit 进入受控链路;
  - Git 门:`git commit/push` 前做**评审状态标记校验**(不再重跑静态分析)。标记由 `scripts/review-mark.js` 在评审完成时写入,内含评审时刻的 diff 指纹——改动未评审、或评审之后又有新 `.java` 改动(指纹不匹配)即阻断;ocr CLI 缺失时按 `failureMode` 降级(`open`=留痕放行/`strict`=拒绝)。
- **Stop(回合末)**:格式化自动修复(google-java-format)+ 可选深度扫描 + **评审提醒**——同步跑 `ocr delegate preview`,把文件清单与规则预注入上下文(best-effort,送达依赖宿主),并落 hook-state 供 git 门比对;清单超过 `performance.stopMaxFiles`(默认 30)时截断,超额部分标注 partial/INCONCLUSIVE,提示分批评审。
- PostToolUse(Edit|Write)对 `.java` 只做队列标记、不做检查(省去每次编辑的外部进程开销),检查收敛到回合级 delegate 评审。

**信任模型(如实)**:git 门是"标记校验"而非"客观复检"——防遗忘、防偷懒,不防伪造(AI 理论上可手写标记或改 hook 脚本自毁门禁;这与引入前"AI 可绕过静态分析工具"是同级风险)。真正的确定性兜底是交付前的 pom 三类检查与 AI 全量评审流程。

## 4. 接入已有代码的项目(存量工程)

机制天然适配存量项目:**编辑期只评审改动的文件**(改哪治哪,不对全库扫违规);接入时注意四点:

1. **AGENTS.md 不覆盖**:推送/拷贝到已有项目时,若目标已有自己的 AGENTS.md,安装器会跳过(它是项目身份文件);需要模板的质量约定请把相关条目人工合并进去。
2. **只拷核心也行**:已有约定的项目可以只拷 `.zcode/` + `.claude/` + `.opencodereview/` + `scripts/`(+ `.tools/`),不带 AGENTS.md/docs。
3. **存量改动的首次噪音**:第一次评审某个老文件时,该文件的历史遗留问题会随报告出现(增量治理的特性而非误报);修不修按团队节奏,报告只覆盖改动行,历史问题仅作上下文。
4. **非 git 项目评审退化**:无 `.git` 时 `ocr delegate preview` 与 Git 门都失效(前者依赖 git diff),回合级评审退化为提醒 + 纪律,交付前 pom 检查兜底(见第 5 节);建议项目 git 化。
5. **交付门禁照旧**:pom 里没配三类检查的,按 `docs/CODE_QUALITY_TOOLS.md` 在首个交付前补齐;交付前 AI 全量评审按 `docs/RELEASE_PROCESS.md` 执行。

## 5. 已知取舍与边界

**门禁词法的已知取舍**(代码审查实测归档):
- 测试夹具/注释里的示例口令字面量会被写入前门 deny(宁误报取向);需要密钥样本时放 `src/test/resources` 等非 .java 位置,或临时调整门禁开关。
- 词法门禁有漏检面:`cp template.txt A.java`、`perl -pi -e`、`node -e fs.writeFileSync`、`sed --in-place`(长参)不拦——由回合级评审与 Git 门收敛,风险限于回合内延迟发现。
- `sk-` 前缀正则可能误拦 ≥20 字符的普通 slug(如 `sk-frontend-registry-cache-key`);`authToken`/`db_password` 等复合名漏检(由评审规则兜底)。
- Edit 模式下高危行号是 new_string 内的相对行号,与文件实际行号可能不符。
- MultiEdit 工具的 edits[] 数组不经写入前高危检测(回合级评审兜底)。

**评审链路的已知取舍**:
- LLM 评审非确定:同一代码两次评审的发现可能不同;漏检由交付前 pom 三类检查兜底。
- 污点分析弱于字节码级工具(SpotBugs+FindSecBugs):深层数据流问题编辑期评审可能看不到,需要时开第 2 节深度扫描。
- 评审状态标记防惰性不防伪造(信任模型见第 3 节)。
- **无 `.git` 的项目退化**:git 门恒空、`ocr delegate preview` 无法运行——编辑期评审退化为提醒 + 纪律,构建插件/代码生成器等其它途径的重写也不进评审视野,由 `mvn verify`/CI 收敛,建议项目 git 化。
- `ocr` 上游年轻:本机制只依赖 preview/rule 的 stdout 契约,上游破坏性变更的影响面=清单与规则的取法(有降级路径),评审本身不受影响。

## 6. 多宿主接入(ZCode 与 Claude Code)

资产自带两份宿主配置,**并存互不干扰**(各宿主只认自己的文件):`.zcode/config.json`(ZCode)与 `.claude/settings.json`(Claude Code),指向同一个 `scripts/hook-runner.js`——runner 自动识别两家的项目目录变量。

| 差异点 | ZCode | Claude Code |
|---|---|---|
| 配置位置 | `.zcode/config.json`(`hooks.enabled` 总开关) | `.claude/settings.json`(无总开关) |
| 项目目录变量 | `${ZCODE_PROJECT_DIR}` | `${CLAUDE_PROJECT_DIR}` |
| 超时单位 | `timeoutMs`(毫秒) | `timeout`(秒) |
| deny 输出形状 | `{decision:"deny",reason}` + exit 2 | `hookSpecificOutput.permissionDecision:"deny"` + exit 0(顶层 `decision` 仅收 approve/block,legacy 形状会被 schema 校验拒绝并 fail-open) |
| 首次生效/审核 | 工作区信任弹窗(见 scripts/README FAQ 的恢复手册) | Claude Code 对项目 settings 中的 hooks 有自己的确认提示,机制不同 |
| matcher 别名 | ApplyPatch→Write/Edit | 另有 MultiEdit 工具(matcher 已含);Windows 的 shell 工具名为 **PowerShell**(无 Bash 工具),命令门 matcher 已含 `Bash\|PowerShell` |
| 斜杠命令 | 未经证实能否加载 `.claude/commands/` | `/delegate-review`(评审命令,`ocr` CLI 驱动,与 hook 无绑定) |

**实测状态(如实)**:ZCode 侧已实证——引擎触发、写入前 deny、PostToolUse 回灌、Stop 的动作链(格式化改写、台账写入、队列清空);**但 Stop 的 additionalContext 提示在一次实测中未注入模型上下文**(文件确被格式化改写,模型却未收到"已自动格式化"提示;单次观测,复测待做)。在结论明确前,不要把"没看到 Stop 提示"当作"文件没被改写"的信号——回合结束后继续编辑前,先重新 Read 相关文件,否则 Edit 可能匹配失败。候选对策(仅 ZCode 宿主需要;Claude Code 已实证送达,若实现须按宿主区分,避免正常送达时重复打扰):Stop 把"已自动格式化"通知写入 hook-state,由下一次 PostToolUse 在回灌开头转告,绕开 Stop 送达通道。Claude Code 侧**真机已验**(Windows,claude CLI 2.1 无头模式,PowerShell 宿主):PostToolUse 回灌逐字送达模型;Stop additionalContext 以 `hook_additional_context` 注入并**驱动模型续回合**(与 ZCode 相反,送达通道完好);曾发现两层问题并已修复:① Windows Claude Code 无 Bash 工具、shell 为 PowerShell,matcher 未含时防旁路门完全空转(`echo > x.java` 真机落盘)——matcher 增补 `PowerShell` + runner 增补 cmdlet 检测;② 复测又暴露 deny 输出为 legacy 形状,被 v2.1.278 的 schema 校验整体拒绝且 fail-open 放行(deny 分支在该宿主从未真正生效)——deny 已按宿主分派(见上表)。两修后真机复测:两种 PowerShell 旁路均被拦下、拒绝理由送达模型。另注意:PowerShell `>` 重定向写文件自带 UTF-8 BOM。

- **格式化双层取舍**:本 hook 用 google-java-format(4 空格/100 列),pom 侧 Spotless
  (palantir,120 列)与它风格不同——并存时的重排代价与两种消振办法(关
  `formatter.enabled` / Spotless 改配 googleJavaFormat AOSP)见
  `docs/CODE_QUALITY_TOOLS.md` 第 5 节。将来可选:formatter 委托项目 Spotless 的 mode
  (风格单一来源,代价是每次编辑走一次 Maven),真实项目感到痛时再实现。
- 其余边界(hook 不替代 verify/CI、工具 JVM 与项目 JDK 解耦)见 `scripts/README.md`。
