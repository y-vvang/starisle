'use strict';
const { needsAdmin } = require('../auth/guard');

const D = (data, status = 200) => ({ status, data });

const HANDLERS = [
  require('./auth'),
  require('./domains'),
  require('./settings'),
  require('./projects'),
  require('./courses'),
  require('./mentors'),
  require('./users'),
  require('./notifications'),
];

async function handle(ctx) {
  // ctx.seg 必须是完整、未剥离前缀的路径分段(见 guard.js:needsAdmin 的契约①,
  // 它假定 seg[0]==='api'、检查 seg[1]==='admin')。调用方(server.js)只能传
  // pathname.split('/').filter(Boolean) 的原样结果,不能先掐掉 /api。
  if (needsAdmin(ctx.method, ctx.seg) && (!ctx.user || ctx.user.role !== 'admin')) {
    return D({ error: '需要站长身份', code: 'admin_required' }, ctx.user ? 403 : 401);
  }
  for (const h of HANDLERS) {
    const r = await h(ctx, D);
    if (r) return r;
  }
  return D({ error: 'unknown api' }, 404);
}

module.exports = { handle, D };
