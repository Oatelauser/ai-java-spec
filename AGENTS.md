# 全局工作约定

## 沟通
- 主动提醒坑点:涉及生产环境、外部系统限制、并发/边界、易错配置时,明确指出风险和实战注意事项,而不是只给一个"能跑"的方案。

## 代码风格
- 遵循 Clean Code:Stepdown Rule / Composed Method / SLAP。入口方法只做高层表达,细节下沉到意图清晰的私有方法;防卫返回减少嵌套;复杂逻辑提取方法;命名揭示意图。避免过度设计与过度工程。
- 注释用 Rationale-Oriented 风格:只对复杂业务规则、兼容逻辑、外部约束、执行顺序、易误改处补注释,说明"为什么"及约束/样例;不逐行复述代码。
- 写、改、重构代码前对照 [编码行为准则](docs/KARPATHY_GUIDELINES.md)。

## 质量门禁(Java)
- 规范基准:阿里 Java 开发手册(以 alibaba/p3c 仓库最新版为准,当前黄山版)。
- 项目必须配置规约(p3c-pmd)、格式化(Spotless)、安全(SpotBugs+FindSecBugs、OWASP dependency-check)三类检查;未配置时按 [质量工具手册](docs/CODE_QUALITY_TOOLS.md) 配进根 pom,全局配置、按模块执行。
- 修改 Java 代码后:先跑与改动直接相关的测试,再按手册运行检查并修复全部违规;禁止用调阈值、加豁免让构建变绿。

## 交付与发版
- 交付时报告实际运行的命令与结果证据;未验证、未运行的事项如实列出,不得宣称完成。
- 版本规划、发布日动作、打 tag 遵循 [发布流程](docs/RELEASE_PROCESS.md)。

## 知识文档(按需)
- 作为公共项目 [发布 Maven Central 流程](docs/MAVEN_CENTRAL_PUBLISHING.md)。
- 项目明确要求二进制原生部署，遵守 [Native Image 手册](docs/GRAALVM_NATIVE_IMAGE_SUPPORT.md)。