-- 项目互动:海报上传 / 关注 / 申请加入。
-- 只新增,不改 001_init.sql(迁移按文件名顺序应用并记入 schema_migrations)。

-- 海报用 base64 data URI 存成 text 列,不引入静态文件服务/对象存储。
-- 大小上限在 app/routes/projects.js 里按字符数校验(约 512KB 解码后),
-- 具体理由见该文件顶部注释与任务报告。
ALTER TABLE projects ADD COLUMN poster text;

CREATE TABLE project_follows (
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- 复合主键:同一用户关注同一项目两次在数据库层面就不可能出现第二行,
  -- 不依赖应用层"先查后插"去重(那正是旧实现"裸计数器"能被反复叠加的原因)。
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX ON project_follows (user_id);

CREATE TABLE project_join_requests (
  id          bigserial PRIMARY KEY,
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  decided_by  bigint REFERENCES users(id),
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON project_join_requests (project_id);
CREATE INDEX ON project_join_requests (user_id);
-- 部分唯一索引:同一用户对同一项目最多只能有一条"待处理"申请。
-- 被拒绝后 status 变成 'rejected',不再匹配这个 WHERE 条件,于是可以重新提交——
-- 而普通的(project_id,user_id)唯一约束做不到"允许历史记录、只挡当前重复"。
CREATE UNIQUE INDEX project_join_requests_pending_uniq
  ON project_join_requests (project_id, user_id) WHERE status = 'pending';
