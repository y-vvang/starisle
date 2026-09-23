'use strict';
/* 路由分级。判定顺序:
   ① /api/admin/* 一律后台 → ② 保留动词 → ③ 公开白名单 → ④ 默认拒绝。
   ④ 是刻意的:漏登记的新端点会立刻 401(响亮),而不是静默公开(致命)。 */

const ADMIN_VERBS = new Set(['review', 'decide', 'grant', 'clear', 'pending', 'suspend']);

/* 纪律,给所有以后往这张表里加行的人:下面这几条 `:param` 通配符规则
   (GET /api/projects/:slug、PATCH /api/projects/:slug、
   GET /api/members/:username)会让任何方法+段数+前缀凑巧撞上的未来路由
   被静默判为公开,不会走到 needsAdmin() 第④步的默认拒绝。
   所以:任何站长专属的新端点必须挂在 /api/admin/ 前缀下 —— 这样第①层
   (seg[1]==='admin')会在通配符匹配跑到之前就把它判成后台,不要指望
   "没登记进这张表就默认拒绝"这条保证能替你挡住这三个通配符形状。
   详见 docs/API.md、docs/ARCHITECTURE.md,以及 test/guard.test.js 里
   钉住这张表通配符清单的那条测试。 */
const PUBLIC_ROUTES = [
  'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/domains', 'GET /api/stats', 'GET /api/settings/public',
  'GET /api/projects', 'POST /api/projects',
  'GET /api/projects/:slug', 'PATCH /api/projects/:slug',
  'POST /api/projects/:slug/members',
  'POST /api/projects/:slug/poster', 'DELETE /api/projects/:slug/poster',
  'GET /api/projects/:slug/follow', 'POST /api/projects/:slug/follow',
  'POST /api/projects/:slug/join', 'GET /api/projects/:slug/join-requests',
  // 注意:不是 'POST /api/join-requests/:id/decide' —— 'decide' 是保留动词
  // (见下面②),路径里任意一段撞上它就一律后台,不看白名单。这条端点的真实
  // 权限是"该项目 owner 或站长"而非"仅站长",所以特意选了 'decision' 这个
  // 不在 ADMIN_VERBS 里的词,而不是去改 needsAdmin 给 'decide' 开洞——
  // test/guard.test.js 里 `isAdmin('POST', '/api/anything/decide')` 那条
  // 用例钉死了"保留动词即后台,不依赖有人记得改表"这个不变量,不应该为了
  // 单个端点破例。
  'POST /api/join-requests/:id/decision',
  // 课程中心的公开面。形状核对过:GET /api/courses(2 段)与 GET /api/courses/:slug(3 段)
  // 的字面段是 courses,不会撞上 projects/members 那几条通配符规则;GET /api/my/courses
  // 三段全是字面段,更不会。站长侧的建课/审课/审报名一律在 /api/admin/ 下,由层①拦截。
  'GET /api/courses', 'GET /api/courses/:slug',
  'POST /api/courses/:slug/enroll', 'GET /api/my/courses',
  // 导师目录与指导申请。撤回刻意写成 POST .../:id/withdraw 而不是
  // DELETE /api/mentor-requests/:id —— 后者的通配符落在末段,会再加一条高危规则。
  'GET /api/mentors', 'GET /api/mentors/:slug',
  'POST /api/mentors/:slug/requests',
  'GET /api/my/mentor-requests', 'POST /api/mentor-requests/:id/withdraw',
  'GET /api/partners',
  'GET /api/members', 'GET /api/members/:username',
  'GET /api/notifications', 'POST /api/notifications/read',
  'PATCH /api/me',
];

function matchRoute(rule, method, seg) {
  const sp = rule.indexOf(' ');
  if (rule.slice(0, sp) !== method) return false;
  const rs = rule.slice(sp + 1).split('/').filter(Boolean);
  if (rs.length !== seg.length) return false;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i][0] !== ':' && rs[i] !== seg[i]) return false;
  }
  return true;
}

function needsAdmin(method, seg) {
  if (seg[1] === 'admin') return true;                              // ①
  if (seg.some(s => ADMIN_VERBS.has(s))) return true;               // ②
  if (PUBLIC_ROUTES.some(r => matchRoute(r, method, seg))) return false; // ③
  return true;                                                       // ④
}

module.exports = { needsAdmin, matchRoute, PUBLIC_ROUTES, ADMIN_VERBS };
