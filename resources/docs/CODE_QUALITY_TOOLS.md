# Java 质量工具配置手册(规约检查 + 格式化 + 安全)

> 资料文件。新建/接手 Maven 项目时按本文配置;修改 Java 代码后按"AI 执行约定"运行检查。
> 三类检查统一绑在 `verify` 阶段,一条 `mvn -DskipTests verify` 全部触发。
> 本文是**交付门禁**(全量),也是全项目**唯一确定性全量检查**——编辑期与交付前的 AI 评审(OCR delegate,LLM 非确定)以本文三类构建级检查为最终兜底,两者互补(编辑期机制见第 5 节)。
> 版本号为 2026-09 的参考值,初始化时用 `mvn versions:display-plugin-updates` 校准;
> **唯一不许升级的是 maven-pmd-plugin(必须钉在 3.21.x,原因见下)**。

## 0. 全局配置还是只配某个模块?

**结论:配置全局(根 pom),执行按模块。**

- 配置统一放根 pom 的 `<pluginManagement>`(声明版本+通用配置)+ 根 `<build><plugins>`
  (全局启用),所有子模块继承。模板项目的意义就是统一质量门禁;插件配置下放到
  单个模块会造成各模块版本/规则漂移,后期合并代价大。
- AI 只改某个模块时,用 `-pl` 只对该模块执行检查,不必全量跑:
  ```bash
  mvn -DskipTests verify -pl <module> -am   # -am 顺带构建其依赖模块
  ```
- 个别模块确实要豁免(如生成代码、legacy 模块):在**该模块** pom 里加
  `<configuration><skip>true</skip>` 逐项关闭(pmd/spotless/spotbugs/
  dependency-check 均支持),而不是把插件配置搬到模块里。

## 1. 规约检查:p3c-pmd(阿里 Java 开发手册)

先纠正一个常见误解:**P3C 官方没有 Checkstyle 实现**。官方实现是
`p3c-pmd`(PMD 规则包,配 Maven/Gradle 插件)+ IDEA 插件(Alibaba Java
Coding Guidelines,人工在编辑器里用,**AI 无法感知它**,对 AI 只有 Maven 这条路)。

根 pom 配置:

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-pmd-plugin</artifactId>
  <version>3.21.2</version> <!-- 必须钉 3.21.x:3.22.0 起升级 PMD 7,与 p3c-pmd(PMD 6)不兼容 -->
  <executions>
    <execution>
      <goals><goal>check</goal></goals> <!-- 绑 verify,违规即构建失败 -->
    </execution>
  </executions>
  <configuration>
    <printFailingErrors>true</printFailingErrors>
    <rulesets>
      <ruleset>rulesets/java/ali-naming.xml</ruleset>
      <ruleset>rulesets/java/ali-oop.xml</ruleset>
      <ruleset>rulesets/java/ali-concurrent.xml</ruleset>
      <ruleset>rulesets/java/ali-set.xml</ruleset>
      <ruleset>rulesets/java/ali-constant.xml</ruleset>
      <ruleset>rulesets/java/ali-exception.xml</ruleset>
      <ruleset>rulesets/java/ali-comment.xml</ruleset>
      <ruleset>rulesets/java/ali-flowcontrol.xml</ruleset>
      <ruleset>rulesets/java/ali-other.xml</ruleset>
    </rulesets>
  </configuration>
  <dependencies>
    <dependency>
      <groupId>com.alibaba.p3c</groupId>
      <artifactId>p3c-pmd</artifactId>
      <version>2.1.1</version>
    </dependency>
  </dependencies>
</plugin>
```

已知约束(动手前必读):

1. **maven-pmd-plugin 3.22.0+ 用 PMD 7,与 p3c-pmd 2.1.1(PMD 6)不兼容**,直接报错,钉死 3.21.2。
2. **p3c-pmd 2.1.1 是 2020-08 的最后一次发布**,规则停留在嵩山版时代;黄山版(2022.2)手册的
   增补不在规则里。规范文本仍以黄山版为准,工具检查不到的部分靠人工/AI 自觉。
3. PMD 6.55 对 JDK 17 解析正常;JDK 21 新语法(record patterns 等)可能误报,遇到时
   用 `<excludes>` 排文件,不要关整套规则。

## 2. 格式化:Spotless

```xml
<plugin>
  <groupId>com.diffplug.spotless</groupId>
  <artifactId>spotless-maven-plugin</artifactId>
  <version>2.43.0</version>
  <executions>
    <execution>
      <id>spotless-check</id>
      <goals><goal>check</goal></goals>
      <phase>verify</phase>
    </execution>
  </executions>
  <configuration>
    <java>
      <palantirJavaFormat/>
      <removeUnusedImports/>
      <importOrder/>
    </java>
  </configuration>
</plugin>
```

选型说明:

- 用 **palantir-java-format** 而不是默认的 google-java-format:后者强制 2 空格缩进,
  与阿里手册的 4 空格缩进、120 字符行宽冲突;palantir 是 4 空格 + 120 列,与手册一致。
- 运行时要求 JDK 11+。
- 团队若要和 IDEA 格式化完全一致,可改用 `<eclipse>` formatter + IDEA 导出的
  profile 文件,配置成本高一些。
- 与编辑期 hook 并存:按本节配进**根 pom** 后,hook 回合末格式化自动委托
  `mvn spotless:apply`(风格权威唯一,两层不再互踩);未配时 hook 用自带
  google-java-format(4 空格/100 列)离线兜底,取舍见第 5 节。
- 日常开发:**写完代码先 `mvn spotless:apply` 自动格式化**,`check` 留给 verify/CI。

## 3. 安全检查:SpotBugs(+FindSecBugs)与 OWASP dependency-check

静态安全缺陷(注入、弱加密、反序列化等)用 SpotBugs + FindSecBugs;依赖 CVE 用
dependency-check。两个互补,都要。

```xml
<plugin>
  <groupId>com.github.spotbugs</groupId>
  <artifactId>spotbugs-maven-plugin</artifactId>
  <version>4.8.6.4</version>
  <executions>
    <execution>
      <id>spotbugs-check</id>
      <goals><goal>check</goal></goals>
    </execution>
  </executions>
  <configuration>
    <effort>Max</effort>
    <threshold>Medium</threshold>
    <xmlOutput>true</xmlOutput>
  </configuration>
  <dependencies>
    <dependency>
      <groupId>com.h3xstream.findsecbugs</groupId>
      <artifactId>findsecbugs-plugin</artifactId>
      <version>1.13.0</version>
    </dependency>
  </dependencies>
</plugin>

<plugin>
  <groupId>org.owasp</groupId>
  <artifactId>dependency-check-maven</artifactId>
  <version>10.0.4</version>
  <configuration>
    <nvdApiKey>${env.NVD_API_KEY}</nvdApiKey>
    <failBuildOnCVSS>7</failBuildOnCVSS>
  </configuration>
</plugin>
```

已知约束:

- SpotBugs 分析的是字节码,必须在 compile 之后跑(绑 verify 已满足;单独跑要先 `mvn compile`)。
  误报用 `spotbugs-exclude.xml` 按 bug pattern 精确豁免,不要全局降阈值。
- dependency-check:2023 年底起 NVD API 强制免费 API key(官网注册,环境变量
  `NVD_API_KEY`);首次下载数据库慢(分钟到十分钟级),之后增量很快。
  国内网络建议由 CI 定期跑,本地开发可 `-DdepCheck.skip=true` 跳过。

## 4. AI 执行约定(写给 AI 的指令)

1. **新建项目 / 接手未配置的项目**:把本文三个插件配进根 pom(全局)。配置时机为"首个交付前到位"即可,
   不必先于写码——新项目可直接先写功能(hook 在编辑期兜底),交付前补齐并跑 `mvn -DskipTests verify`
   确认门禁生效。
2. **日常修改 Java 代码后,交付前必须**:
   ```bash
   mvn spotless:apply
   mvn -DskipTests verify -pl <改动的模块> -am
   ```
   违规即失败;报告位置:`target/pmd.xml`、`target/spotbugsXml.xml`、
   `target/dependency-check-report.html`,按报告逐条修复,不允许靠调阈值/加豁免"让构建变绿"。
3. 豁免必须精准:PMD/SpotBugs 按规则或文件排除,并在豁免处注明原因(对应
   AGENTS.md 的 Rationale-Oriented 注释要求)。
4. 改的是单模块就只跑该模块(见第 0 节),不要无差别全量构建拖慢迭代。

## 5. 编辑期检查:项目级 hook(与 verify 门禁互补)

本项目自带一套**项目级 hook**(ZCode 与 Claude Code 双宿主),在 AI 写 `.java` 的当下与
回合末做增量约束:写入前密钥拦截、回合末格式化自动修复、回合级 OCR delegate 评审
(宿主模型按 `.opencodereview/rule.json` 的 p3c 蒸馏规约评审当轮改动)。机制、配置与
排障见 [scripts/README.md](../scripts/README.md) 与
[QUALITY_HOOK_GUIDE.md](QUALITY_HOOK_GUIDE.md)。

与 pom 门禁的关系:**hook 评审是编辑期反馈(LLM 非确定、只覆盖当轮改动),本文的
verify/CI 是确定性全量门禁**,两者互补;交付前另需 AI 全量评审(上一版本..本版本
diff,见 AGENTS.md 交付门禁段)。

**格式化的双模式协作**:hook 回合末格式化按根 pom 自动分派——根 pom 按第 2 节配了
Spotless 时,hook **委托 `mvn spotless:apply`**(风格权威唯一归 pom,与
`spotless:check` 门禁零互踩);未配时用自带 google-java-format(4 空格/100 列)离线
兜底。边界:hook 只探测**根 pom**,子模块单独配 Spotless 不识别——那种布局下两层风格
仍会互踩(palantir 120 列 vs GJF 100 列),需委托就把插件声明提级到根 pom;不能提级时
二选一消振:关闭 hook 的 `formatter.enabled`,或把 Spotless 改配
`<googleJavaFormat><style>AOSP</style></googleJavaFormat>` 与 hook 对齐(代价是放弃
120 列、偏离手册列宽条款)。
