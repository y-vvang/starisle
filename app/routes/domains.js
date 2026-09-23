'use strict';
const { query } = require('../db/pool');

module.exports = async function domainRoutes(ctx, D) {
  if (ctx.method === 'GET' && ctx.path === '/api/domains') {
    const r = await query('SELECT id,name,color FROM domains ORDER BY sort');
    return D({ domains: r.rows });
  }
  if (ctx.method === 'GET' && ctx.path === '/api/stats') {
    const r = await query(`
      SELECT (SELECT count(*) FROM users    WHERE status='approved')::int AS members,
             (SELECT count(*) FROM projects WHERE status='approved')::int AS projects`);
    return D(r.rows[0]);
  }
};
