-- 项目详情页的三块内容:02 主要工作 / 03 阶段性成果 / 04 当前需求。
-- 这三块此前在前端是写死的空值(ProjectDetailPage.vue 的 adapt() 里 work:'' /
-- milestones:[] / gapsDetail:[]),数据库根本没有对应列 —— 于是任何项目打开详情页,
-- 那三张卡永远是空框、"成果正在路上 ✦"、"当前无公开缺口。"。这次把它们变成真数据。
--
-- 只新增,不改前两个迁移(迁移按文件名顺序应用并记入 schema_migrations)。

-- 一段自由文本,对应 02 主要工作。允许 NULL:没写过和写了空字符串是两回事。
ALTER TABLE projects ADD COLUMN work text;

-- 下面三列都用 jsonb 而不是 text[]:
--   gaps 的元素是对象 {skill, note}(模板要渲染「缺一名『前端』· 会 Vue 优先」),
--   text[] 装不下;三列统一成 jsonb,读写只有一套取值方式,不必在应用层分流。
-- NOT NULL + DEFAULT '[]' 让"没填"在读取端就是空数组,前端不需要再兜底一次 null。
ALTER TABLE projects ADD COLUMN stack      jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN milestones jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN gaps       jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 条目数与单条长度的上限卡在应用层(app/routes/projects.js 的 parseStringList/parseGaps),
-- 不在这里加 CHECK:jsonb 的长度约束写成 CHECK 会很难读,且错误信息对用户毫无意义,
-- 应用层能给出「阶段性成果最多 20 条」这种能照着改的提示。
