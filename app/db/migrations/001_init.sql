CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE domains (
  id        text PRIMARY KEY,          -- 'agent' / 'edu' / ...
  name      text NOT NULL,
  color     text NOT NULL,
  sort      int  NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id             bigserial PRIMARY KEY,
  username       citext UNIQUE NOT NULL,
  password_hash  text NOT NULL,
  display_name   text NOT NULL,
  email          citext UNIQUE NOT NULL,
  repo_url       text,
  bio            text,
  role           text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','suspended')),
  apply_note     text,
  review_note    text,
  reviewed_by    bigint REFERENCES users(id),
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,                    -- 32 随机字节 base64url
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);

CREATE TABLE projects (
  id           bigserial PRIMARY KEY,
  slug         citext UNIQUE NOT NULL,
  name         text NOT NULL,
  tagline      text,
  description  text,
  repo_url     text,
  domain_id    text REFERENCES domains(id),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected')),
  owner_id     bigint NOT NULL REFERENCES users(id),   -- 「绑到我身上」
  review_note  text,
  reviewed_by  bigint REFERENCES users(id),
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON projects (status);
CREATE INDEX ON projects (owner_id);

CREATE TABLE project_members (
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- ← 不再是 persona id
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, read_at);

CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);

INSERT INTO domains (id, name, color, sort) VALUES
  ('agent',    'Agent 与工具',  '#2f6fd0', 1),
  ('edu',      '教育公平',      '#c2891b', 2),
  ('climate',  '气候与环境',    '#2f6fd0', 3),
  ('health',   '医疗健康',      '#c2891b', 4),
  ('creative', '创意与艺术',    '#c2891b', 5),
  ('infra',    '开源基础设施',  '#2f6fd0', 6);

INSERT INTO settings (key, value) VALUES ('registration_open', 'true'::jsonb);
