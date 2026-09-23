import { reactive } from 'vue';
import { api, post, patch, del, toast } from '../lib/api';
import { go } from '../lib/router';

export const store = reactive({
  ready: false,
  user: null,                 // 当前登录用户(来自 HttpOnly cookie 会话),未登录为 null
  domains: [], dcolor: {}, dname: {},
  stats: {},
  projects: [],
  members: [],
  registrationOpen: true,
  // courses 现在是真数据(GET /api/courses,只含已发布的),首页那条 strip 不再是空壳。
  courses: [],
  // 以下字段在新后端里仍没有对应端点(专栏/活动/学生报道/资源这几个产品模块
  // 已在前端重写中整体下线,见删除前一次提交)。保留为安全的空默认值,只是为了让
  // 还没重做的旧壳组件(HomePage 的对应几条 strip)取用时不报错、优雅渲染成空列表,
  // 而不是抛异常把整页拖垮。
  gatherings: [], talent: [],
  homeConfig: { heroTitle: '', heroDesc: '', featured: { projects: [], courses: [], columns: [], activities: [], students: [], resources: [] } },
  highlights: { posts: [], pulse: [], chronicles: [] },
  // UI 状态:加入弹窗、成员详情抽屉 —— 壳组件(JoinModal / DrawerView)仍在用
  // authMode 区分同一个弹窗的两种用途:'register'(申请加入)/ 'login'(登录)。
  joinOpen: false,
  authMode: 'register',
  drawer: { open: false, kind: '', data: null },
});

// 把 /api/projects 的真实卡片({slug,name,tagline,domain_id,status,owner,...})
// 适配成旧壳组件期望的形状:id(=slug,原来是数字 id,壳组件只用它做 key 和路由参数,
// 值本身是什么类型无所谓)、domain(=domain_id)、以及新后端压根没有的 gaps/members
// 兜底成空数组,避免模板里 `p.gaps.length` / `p.members.length` 这类无 v-if 保护的
// 直接访问在真实数据上炸掉。
function cardifyProjects(list) {
  return (list || []).map(p => ({ ...p, id: p.slug, domain: p.domain_id, gaps: p.gaps || [], members: p.members || [] }));
}

// 拉首屏所需的全部数据。每个字段都带兜底(|| []/{}),任意一个接口失败都不能
// 阻止 store.ready 变 true —— 上一版 boot() 没做到这一点,直接把全站渲染成空壳。
// 课程卡片适配:后端给 instructors(复数,顿号分隔的署名串),而首页那条 strip 的
// 旧模板取的是 c.instructor(单数)、c.kind。用 track 顶掉已删除的 kind,
// 顺手把它变成真数据 —— 这一条 strip 因此不再是空壳。
export const TRACKS = {
  math: '数学基础', literacy: '人工智能通识',
  extension: '学科拓展', application: 'AI 编程与应用',
};
const cardifyCourses = list => (list || []).map(c => ({
  ...c, instructor: c.instructors || '', kind: c.track,
}));

export async function boot() {
  const [me, domains, projects, members, stats, settings, courses] = await Promise.all([
    api('/auth/me').catch(() => ({})),
    api('/domains').catch(() => ({})),
    api('/projects').catch(() => ({})),
    api('/members').catch(() => ({})),
    api('/stats').catch(() => ({})),
    api('/settings/public').catch(() => ({})),
    api('/courses').catch(() => ({})),
  ]);
  store.courses = cardifyCourses(courses && courses.courses);
  store.user = (me && me.user) || null;
  store.domains = (domains && domains.domains) || [];
  store.dcolor = Object.fromEntries(store.domains.map(d => [d.id, d.color]));
  store.dname = Object.fromEntries(store.domains.map(d => [d.id, d.name]));
  store.projects = cardifyProjects((projects && projects.projects) || []);
  store.members = (members && members.members) || [];
  store.stats = stats || {};
  store.registrationOpen = !!(settings && settings.registration_open);
  store.ready = true;
}

export async function login(username, password) {
  const r = await post('/auth/login', { username, password });
  if (r && r.ok) store.user = r.user || null;
  return r;
}

export async function logout() {
  const r = await post('/auth/logout', {});
  store.user = null;
  return r;
}

export async function register(payload) {
  return await post('/auth/register', payload);
}

export async function refreshMe() {
  const r = await api('/auth/me');
  store.user = (r && r.user) || null;
  return r;
}

// 需要"已登录"才能做的动作;未登录 → 提示并打开登录弹窗(取代已不存在的 #/login 页)。
// 返回 true 表示放行。取代旧的 requireMember(游客/身份组模型已随本任务整体删除)。
export function requireLogin(what = '操作') {
  if (!store.user) { toast(`请先登录再${what}`); openLogin(); return false; }
  return true;
}

// 项目详情是独立页面(非弹窗);id 现在装的是真实 slug。
export function openProject(id) { go('project/' + id); }

// 成员详情仍是抽屉(DrawerView 的展示逻辑原样保留)。id 现在装的是真实 username。
// 新的 /api/members/:username 只有 {id,username,display_name,bio,repo_url,created_at}
// 这几个真字段,远比旧演示数据(星阶/时区/语言/技能/关系网/成长值/作品集/时间线)单薄——
// 缺的字段一律兜底成空数组/占位值,DrawerView 模板里对应的 v-if 块会自动收起来,
// 不去编造假数据。
export async function openMember(id) {
  const r = await api('/members/' + id);
  if (!r || r.error) { toast('没有找到该成员'); return; }
  const m = r.member;
  const joinedDaysAgo = m.created_at ? Math.max(0, Math.floor((Date.now() - new Date(m.created_at).getTime()) / 86400000)) : 0;
  store.drawer = {
    open: true, kind: 'member',
    data: {
      id: m.username, star: m.display_name || m.username, bio: m.bio || '',
      stage: 'stardust', tz: 0, langs: [], joinedDaysAgo,
      volume: 0, brightness: 0, skills: [], interests: [], spark: [1],
      projects: (r.projects || []).map(p => ({ id: p.slug, name: p.name, tagline: p.tagline, domain: p.domain_id, role: '' })),
      events: [],
    },
  };
}
export function closeDrawer() { store.drawer.open = false; }

// mode: 'register'(默认,申请加入)| 'login'(登录)。JoinModal 是同一个弹窗的两种形态。
export function openJoin(mode = 'register') { store.authMode = mode; store.joinOpen = true; }
export function closeJoin() { store.joinOpen = false; }
export function openLogin() { openJoin('login'); }

// 演示身份 / 工作台系统已随前端重写整体删除;closeWorkbench 仅保留一个空实现,
// 让 PortalApp 的 Escape 快捷键处理器不用跟着改。
export function closeWorkbench() {}

// 关注(成员之间)在新后端里还没有对应端点,保持"筹备中"的柔性降级,不发请求。
export async function actFollow() {
  if (!requireLogin('关注')) return { error: '请先登录' };
  return { error: '关注功能筹备中' };
}

// 项目关注:幂等开关。服务端按当前状态直接返回权威的 following/followers,
// 前端不用自己算"下一步该是什么",照抄响应即可——避免多标签页并发操作时
// 前端自己推算出的状态和数据库对不上("optimistic 但要对")。
export async function actProjectFollow(slug, follow) {
  if (!requireLogin('关注项目')) return { error: '请先登录' };
  return await post(`/projects/${slug}/follow`, { follow });
}

// 申请加入:message 选填,后端会裁到 500 字并允许空。发起人给自己项目申请
// 会被服务端拒(400)——这里不重复校验,按钮本来就不会渲染给 owner 看。
export async function actProjectJoin(slug, message) {
  if (!requireLogin('申请加入')) return { error: '请先登录' };
  return await post(`/projects/${slug}/join`, { message: message || '' });
}

// 路演海报:上传 / 删除,只有 owner 或站长能改。后端已经把权限锁死了,这里
// 不重复判断——调用点(ProjectDetailPage 的 isOwnerOrAdmin)只对 owner/站长
// 渲染这两个按钮,别人根本点不到。
export async function actProjectPoster(slug, dataUrl) {
  if (!requireLogin('上传海报')) return { error: '请先登录' };
  return await post(`/projects/${slug}/poster`, { poster: dataUrl });
}
export async function actProjectPosterRemove(slug) {
  if (!requireLogin('移除海报')) return { error: '请先登录' };
  return await del(`/projects/${slug}/poster`);
}

// 加入申请队列:只有项目 owner 或站长能看/能处理,后端已鉴权,这里只是薄封装。
export async function fetchJoinRequests(slug) {
  const r = await api(`/projects/${slug}/join-requests`);
  return (r && r.requests) || [];
}
// 端点是 /decision 不是 /decide,见 app/routes/projects.js 顶部那条注释——
// 'decide' 是路由守卫里的保留动词,撞上会被强判成"仅站长",而这条端点的
// 真实权限是"owner 或站长"。
export async function actJoinRequestDecision(id, decision) {
  return await post(`/join-requests/${id}/decision`, { decision });
}

// 发起项目:接到真实的 POST /api/projects。旧表单字段名(domain/desc/repo)在这里
// 适配成新接口的字段名(domain_id/description/repo_url);founderId/stack/gaps 新接口
// 不认,直接丢弃 —— 发起人由服务端从登录会话推断,不再靠前端传参。
export async function actPublishProject(body) {
  if (!requireLogin('发起项目')) return { error: '请先登录' };
  const r = await post('/projects', {
    name: body.name, tagline: body.tagline, description: body.desc,
    domain_id: body.domain || undefined, repo_url: body.repo || undefined,
    // 「技术栈」「正在找」这两个输入框在表单里一直存在,但此前提交时被丢掉,
    // 用户填了不报错、照样提示"已提交",值却不落库。现在接上真实字段。
    stack: body.stack, gaps: body.gaps,
  });
  if (r && r.ok) {
    const fresh = await api('/projects');
    store.projects = cardifyProjects((fresh && fresh.projects) || []);
  }
  return r;
}

// —— 课程中心 ——

export async function refreshCourses(track = '') {
  const r = await api('/courses' + (track ? `?track=${encodeURIComponent(track)}` : ''));
  store.courses = cardifyCourses(r && r.courses);
  return store.courses;
}

export const fetchCourse = slug => api('/courses/' + encodeURIComponent(slug));

export async function actEnroll(slug, message) {
  if (!requireLogin('申请学习')) return { error: '请先登录' };
  const r = await post(`/courses/${encodeURIComponent(slug)}/enroll`, { message: message || undefined });
  if (r && r.enrollment) toast('申请已提交,等站长开通 ✦');
  else if (r && r.error) toast(r.error);
  return r;
}

export async function fetchMyCourses() {
  const r = await api('/my/courses');
  return (r && r.courses) || [];
}

// 编辑项目:属主或站长。表单是整体提交的,所以整份发过去 —— 后端 collectContent
// 只认请求里出现过的键,传空数组会清空、缺席则原值不动,不会出现"改了名字把成果清空"。
export async function actUpdateProject(slug, body) {
  if (!requireLogin('编辑项目')) return { error: '请先登录' };
  const r = await patch('/projects/' + encodeURIComponent(slug), body);
  if (r && r.ok) {
    const fresh = await api('/projects');
    store.projects = cardifyProjects((fresh && fresh.projects) || []);
  }
  return r;
}
