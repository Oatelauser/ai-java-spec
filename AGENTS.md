# 模板维护约定

本项目是模板:可搬运资产全部在 `resources/`(拷贝其内容到新项目根即完整可用,无需初始化)。维护本模板时遵守:

- 工作约定:`resources/AGENTS.md`
- 编码行为准则:`resources/docs/KARPATHY_GUIDELINES.md`
- 质量门禁/发布流程等文档:`resources/docs/`
- `resources/` 是资产唯一源,改动后先在临时项目实测"拷贝 → hook 跑通"再交付,验证产物随即删除(流程见 `resources/scripts/README.md`)。
