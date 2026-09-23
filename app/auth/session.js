'use strict';
const { randomBytes } = require('node:crypto');
const { query } = require('../db/pool');

const DEFAULT_DAYS = 30;

async function createSession(userId, { userAgent = null, ip = null, days = DEFAULT_DAYS } = {}) {
  const id = randomBytes(32).toString('base64url');
  const r = await query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, $4, $5)
     RETURNING expires_at`,
    [id, userId, String(days), userAgent, ip]
  );
  return { id, expiresAt: r.rows[0].expires_at };
}

async function getSession(id) {
  if (!id || typeof id !== 'string') return null;
  // AND u.status = 'approved':停用生效必须在这里(每次请求都过一遍),不能只
  // 靠 suspend 端点那条"UPDATE users ... 然后另开一条语句删 sessions"的非原子
  // 组合 —— 第二条语句一旦失败,用户的会话行还在、没过期,后面这条查询原本会
  // 照样把人放进来,状态位形同虚设。把 status 判断挪进 WHERE,即使清理 sessions
  // 那步没跑,下一次请求也会因为这一条件直接查不到人。
  const r = await query(
    `SELECT s.id, u.id AS user_id, u.username, u.display_name, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'approved'`,
    [id]
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  return {
    id: x.id,
    // bigint/int8 → Number 现在统一在 db/pool.js 用 pg 的类型解析器在源头修好
    // (setTypeParser(20, Number)),x.user_id 天生就是 Number,这里不用再
    // 手工 Number(...) 转一次。之前这里是 ctx.user.id 唯一的转型点,是为了让
    // 后续所有 `xxx === ctx.user.id` 的比较不因为「数字 === 字符串」永远为
    // false 而变成死代码(真实案例:suspend 端点的自我停用防护);现在这条
    // 不变量由源头解析器统一保证,不再需要每个出入口各修一次。
    user: { id: x.user_id, username: x.username, display_name: x.display_name,
            role: x.role, status: x.status },
  };
}

const destroySession = (id) => query('DELETE FROM sessions WHERE id=$1', [id]).then(() => undefined);
const destroyUserSessions = (userId) =>
  query('DELETE FROM sessions WHERE user_id=$1', [userId]).then(() => undefined);
const cleanupExpired = () =>
  query('DELETE FROM sessions WHERE expires_at <= now()').then(r => r.rowCount);

module.exports = { createSession, getSession, destroySession, destroyUserSessions, cleanupExpired };
