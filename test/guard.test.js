'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { needsAdmin, PUBLIC_ROUTES } = require('../app/auth/guard');

const seg = p => p.split('/').filter(Boolean);
const isAdmin  = (m, p) => assert.strictEqual(needsAdmin(m, seg(p)), true,  `${m} ${p} 应为后台`);
const isPublic = (m, p) => assert.strictEqual(needsAdmin(m, seg(p)), false, `${m} ${p} 应为公开`);

test('公开端点', () => {
  isPublic('POST', '/api/auth/register');
  isPublic('POST', '/api/auth/login');
  isPublic('POST', '/api/auth/logout');
  isPublic('GET',  '/api/auth/me');
  isPublic('GET',  '/api/domains');
  isPublic('GET',  '/api/stats');
  isPublic('GET',  '/api/projects');
  isPublic('GET',  '/api/projects/lumen');
  isPublic('GET',  '/api/members');
  isPublic('GET',  '/api/members/alice');
  isPublic('GET',  '/api/settings/public');
});

test('登录成员端点也走公开档(由 handler 自己校验登录态)', () => {
  isPublic('POST',  '/api/projects');
  isPublic('PATCH', '/api/projects/lumen');
  isPublic('POST',  '/api/projects/lumen/members');
  isPublic('GET',   '/api/notifications');
  isPublic('POST',  '/api/notifications/read');
  isPublic('PATCH', '/api/me');
});

test('后台端点', () => {
  isAdmin('GET',   '/api/admin/users/pending');
  isAdmin('POST',  '/api/admin/users/7/review');
  isAdmin('POST',  '/api/admin/users/7/suspend');
  isAdmin('GET',   '/api/admin/projects/pending');
  isAdmin('POST',  '/api/admin/projects/7/review');
  isAdmin('PATCH', '/api/admin/settings');
});

test('任何 /api/admin/* 一律后台,包括还没写的', () => {
  isAdmin('GET',    '/api/admin/whatever');
  isAdmin('POST',   '/api/admin/a/b/c/d');
  isAdmin('DELETE', '/api/admin/users/1');
});

test('保留动词即后台,不依赖有人记得改表', () => {
  isAdmin('POST', '/api/projects/7/review');
  isAdmin('GET',  '/api/courses/pending');
  isAdmin('POST', '/api/anything/decide');
});

test('默认拒绝:未登记的路径判为后台', () => {
  isAdmin('GET',  '/api/nonexistent');
  isAdmin('POST', '/api/some/new/endpoint');
  isAdmin('GET',  '/api/users');            // 老的 PII 端点,已不存在,也必须是后台
});

test('方法敏感:GET 公开不等于 DELETE 公开', () => {
  isPublic('GET',    '/api/projects');
  isAdmin ('DELETE', '/api/projects');
});

// 契约④(安全评审确认):公开白名单用 `:param` 通配符表达路由(如
// `GET /api/members/:username`)。白名单里不少路由带 `:param`,但大多数在
// 通配符段后面还跟着一段固定字面量(比如 `POST /api/projects/:slug/members`
// 的 `members`),未来路由要撞上它们必须连那段字面量也凑巧一致,碰撞面很窄。
// 真正危险的是**通配符段本身就是路径最后一段**的那几条规则 —— 这种规则下,
// 任何未来路由只要方法 + 段数 + 前缀凑巧撞上,不管最后一段写什么都会被静默
// 判为公开,不会走到默认拒绝。这不是 bug,是「方法+段数+前缀」匹配机制的
// 固有代价,已知且刻意接受。真正的缓解措施不是在 guard 里加特例(那只会把
// 通配符碰撞问题搬到另一处通配符),而是纪律:**所有后台专属端点必须挂在
// `/api/admin/` 前缀下**,这样第①层(seg[1]==='admin')在通配符匹配跑到
// 之前就已经把它们判成后台,通配符碰撞根本没有机会发生。
//
// 这条测试不钉死"某几个具体碰撞 URL 是公开的"(那样会冻结几个例子,并且让
// 任何想修掉碰撞的人被 CI 挡住);它钉死的是**"通配符段是路径最后一段"这类
// 规则本身的清单**——白名单里一共只应该有这三条。谁往 PUBLIC_ROUTES 里加了
// 第四条这种形状的规则,这条测试就会失败,逼这个人回头读 docs/API.md 和上面
// 这段注释,而不是在不知情的情况下悄悄扩大"静默公开"的路由面。
//
// 【2026-08-18 新增第四条,经评估】课程中心移植时加了 `GET /api/courses/:slug`。
// 这条测试按设计把这次改动拦了下来,下面是评估结论,而不是把数字改大了事:
//   - 碰撞面:任何未来的 `GET /api/courses/<某词>` 会被静默判公开。
//   - 已被上游两层挡住的:六个保留动词(层②早于层③),以及一切挂在 `/api/admin/`
//     下的站长端点(层①早于层③)—— 课程的建课/审课/审报名全部在 `/api/admin/` 下。
//   - 为什么不改成 `GET /api/courses/detail/:slug` 这种"通配符后面再跟一段字面量"
//     的形状(碰撞面确实更窄):那会让课程详情与既有的 `GET /api/projects/:slug`
//     风格分叉,同一个仓库里两种详情 URL 写法,读的人要多记一条例外;而两者面对的
//     风险与缓解手段完全相同。选了一致性。
//   - 为什么不干脆不登记:那样匿名访客连课程详情都打不开(走④默认拒绝 401),
//     而课程目录本来就是要给没注册的人看的。
//
// 【2026-08-18 新增第五条,经评估】导师目录移植时加了 `GET /api/mentors/:slug`。
//   - 碰撞面与前四条同性质:`GET /api/mentors/<某词>` 会被静默判公开。
//     保留动词(层②)与 `/api/admin/` 前缀(层①)都在层③之前,导师模块的建改与
//     审批端点全部挂在 `/api/admin/` 下,不受影响。
//   - **这一轮刻意只加了这一条。** 同批的其他公开端点都被设计成"通配符后面还跟一段
//     字面量"的形状,从而不进这张清单:
//       POST /api/mentors/:slug/requests
//       POST /api/mentor-requests/:id/withdraw   ← 本来更自然的写法是
//                                                  DELETE /api/mentor-requests/:id,
//                                                  但那会让通配符落在末段,再加一条高危规则。
//                                                  与既有的 POST /api/join-requests/:id/decision 同一种取舍。
//     也就是说:能避开就避开,只有"资源详情页"这种确实需要 /:slug 结尾的才进来。
// 下一个想加第六条的人:同样请在这里写下你的评估,别只改数组。
test('公开白名单里"通配符段是路径最后一段"的规则必须只有这五条(新增一条 = 扩大静默公开面)', () => {
  const wild = PUBLIC_ROUTES.filter(r => r.split('/').pop().startsWith(':'));
  assert.deepStrictEqual(wild.sort(), [
    'GET /api/courses/:slug',
    'GET /api/members/:username',
    'GET /api/mentors/:slug',
    'GET /api/projects/:slug',
    'PATCH /api/projects/:slug',
  ]);
});
