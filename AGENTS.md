# 模板维护约定

本项目是模板:可搬运资产全部在 `resources/`(拷贝其内容到新项目根即完整可用,无需初始化)。维护本模板时遵守:

- 工作约定:`resources/AGENTS.md`
- 编码行为准则:`resources/docs/KARPATHY_GUIDELINES.md`
- 质量门禁/发布流程等文档:`resources/docs/`

## 视角铁律(防歧义,写给维护本模板的 AI)

- `resources/` 内的一切**文档**以目标项目视角撰写:路径相对新项目根,不得出现模板侧路径;模板侧操作只写在根 README 与本文件(它们不随拷贝传导)。
- 传导的是 `resources/` 的内容,不是目录本身——新项目根不应出现 `resources/` 这一层;手动拷贝是主通道,`scripts/install.js` 只做预置/推送。
- 入口文档(`resources/scripts/README.md`)保持精简,深度内容放 `resources/docs/QUALITY_HOOK_GUIDE.md` 按需加载。
- 结构性改动动手前,先列一张"写什么文件、给谁看"的受众表确认,防止视角漂移。

## 交付前校验

- 零模板路径:`grep -rnE '(^|[`"(])resources/' resources --include='*.md'` 结果必须为 0
  (`src/main/resources` 等项目内标准路径不算违规;`scripts/install.js` 的模板引用属功能性指路,校验只查 md)。
- 词汇级视角复核:`grep -rnE '本模板|模板侧|新项目传导|拷贝到新项目' resources --include='*.md'`
  命中即人工复核——声明"来自质量模板"的免责句可豁免,可操作的模板侧指引必须清除。
- 相对链接可达:校验 md 内相对链接的目标文件存在(防死引用)。
- 实测传导:临时项目"拷贝 → hook 跑通"再交付,验证产物随即删除;`resources/.tools/` 为预置资产,保留。
