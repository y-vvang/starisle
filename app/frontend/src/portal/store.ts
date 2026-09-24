import { reactive } from 'vue';
import { api, post, patch, del, toast } from '../lib/api';
import type { ApiResp } from '../lib/api';
import { go } from '../lib/router';

// 后端分页响应的兄弟键(lib/pagination.ts 的 pageMeta)
export interface Pagination {
  page: number; per_page: number; total: number; total_pages: number;
}

// —— 与后端响应对应的形状 ——
// 认真类型化的是真实被消费的字段;旧壳组件(docs/MODULES.md 记录的过渡空壳)
// 仍会访问的过渡字段用可选属性 + 索引签名兜住,分页改造清壳时一并收紧。
export interface User {
  id: number; username: string; display_name: string;
  email?: string; repo_url: string | null; bio: string | null;
  role: string; status: string; created_at: string;
}

export interface Domain { id: string; name: string; color: string }

export interface ProjectCard {
  // cardifyProjects 适配出的旧壳形状:id 装的是 slug,domain 装的是 domain_id;
  // gaps/members 兜底成 [](后端卡片不带这两块),activity/demo 恒为 undefined。
  id: string; slug: string; name: string; tagline: string;
  repo_url: string | null; domain_id: string | null; status: string;
  created_at: string; domain: string;
  gaps: { skill: string; note: string }[]; members: unknown[];
  owner?: { username: string; display_name: string };
  [key: string]: any;
}

export interface CourseCard {
  id: number; slug: string; title: string; subject: string | null;
  track: string; summary: string | null; instructors: string | null;
  total_hours: number | null; featured: boolean; status: string;
  lesson_count?: number; created_at: string;
  // 旧壳模板取的字段:instructor(单数署名)、kind —— cardifyCourses 顶掉的别名
  instructor: string; kind: string;
  [key: string]: any;
}

export interface MemberCard {
  id: number; username: string; display_name: string;
  bio: string | null; repo_url: string | null; created_at: string;
  [key: string]: any;
}

// 成员抽屉:openMember 组装的形状。后半段是旧壳字段(关注/成长/作品集/时间线),
// openMember 从不写入,模板靠 v-if 自动收起 —— 行为等价保留,清壳时一并移除。
// 壳字段的类型按 DrawerView 模板的消费形状给出,而不是 any:值恒 undefined,
// 类型只为了让模板取值合法,不代表数据真的长这样。
export interface DrawerMember {
  id: string; star: string; bio: string; stage: string; tz: number;
  langs: string[]; joinedDaysAgo: number; volume: number; brightness: number;
  skills: string[]; interests: string[]; spark: number[];
  projects: { id: string; name: string; tagline: string; domain: string; role: string }[];
  events: any[];
  followers?: { id: string }[];
  followerCount?: number;
  collaborators?: { id: string; star: string }[];
  following?: { id: string; star: string }[];
  growth?: { title: string; points: number; level: number; nextAt?: number;
             badges: { id: string; icon: string; name: string; desc: string }[] };
  portfolio?: any;          // 旧作品集:嵌套深且恒 undefined,不值得逐字段编类型
  timeline?: { kind: string; label: string; detail: string; projectName?: string; ts: string }[];
  [key: string]: any;
}

interface Store {
  ready: boolean;
  user: User | null;
  domains: Domain[]; dcolor: Record<string, string>; dname: Record<string, string>;
  stats: Record<string, number>;
  projects: ProjectCard[];
  // 项目列表的分页缓存:ProjectsSection 的列表页数据走这里
  // (page/domain/filters 变化时由 refreshProjects 重拉;loaded 标志让
  // ProjectEditPage 保存后的 refreshProjects 只刷已加载过的列表)。
  projectsState: {
    loaded: boolean;
    page: number; perPage: number; domain: string;
    list: ProjectCard[];
    pagination: Pagination | null;
    domainCounts: Record<string, number>;
  };
  members: MemberCard[];
  registrationOpen: boolean;
  // courses 现在是真数据(GET /api/courses,只含已发布的),首页那条 strip 不再是空壳。
  courses: CourseCard[];
  coursesPagination: Pagination | null;
  // 以下字段在新后端里仍没有对应端点(专栏/活动/学生报道/资源这几个产品模块
  // 已在前端重写中整体下线)。保留为安全的空默认值,只是为了让还没重做的旧壳
  // 组件(HomePage 的对应几条 strip)取用时不报错、优雅渲染成空列表。
  gatherings: unknown[]; talent: unknown[];
  homeConfig: { heroTitle: string; heroDesc: string; featured: Record<string, string[]> };
  highlights: { posts: unknown[]; pulse: unknown[]; chronicles: unknown[] };
  // 旧演示身份体系的残留读取点:DrawerView 的关注按钮仍判 store.persona,
  // 恒 undefined(按钮永不渲染)。空壳行为等价保留。
  persona?: { ref: string } | null;
  // UI 状态:加入弹窗、成员详情抽屉 —— 壳组件(JoinModal / DrawerView)仍在用
  // authMode 区分同一个弹窗的两种用途:'register'(申请加入)/ 'login'(登录)。
  joinOpen: boolean;
  authMode: string;
  drawer: { open: boolean; kind: string; data: DrawerMember | null };
}

const blankProjectsState = () => ({
  loaded: false,
  page: 1, perPage: 20, domain: '',
  list: [] as ProjectCard[],
  pagination: { page: 1, per_page: 20, total: 0, total_pages: 1 } as Pagination,
  domainCounts: {} as Record<string, number>,
});

export const store = reactive<Store>({
  ready: false,
  user: null,                 // 当前登录用户(来自 HttpOnly cookie 会话),未登录为 null
  domains: [], dcolor: {}, dname: {},
  stats: {},
  projects: [],
  projectsState: blankProjectsState(),
  members: [],
  registrationOpen: true,
  courses: [],
  coursesPagination: null,
  gatherings: [], talent: [],
  homeConfig: { heroTitle: '', heroDesc: '', featured: { projects: [], courses: [], columns: [], activities: [], students: [], resources: [] } },
  highlights: { posts: [], pulse: [], chronicles: [] },
  joinOpen: false,
  authMode: 'register',
  drawer: { open: false, kind: '', data: null },
});

// 把 /api/projects 的真实卡片({slug,name,tagline,domain_id,status,owner,...})
// 适配成旧壳组件期望的形状:id(=slug,原来是数字 id,壳组件只用它做 key 和路由参数,
// 值本身是什么类型无所谓)、domain(=domain_id)、以及新后端压根没有的 gaps/members
// 兜底成空数组,避免模板里 `p.gaps.length` / `p.members.length` 这类无 v-if 保护的
// 直接访问在真实数据上炸掉。
function cardifyProjects(list: ProjectCard[] | null | undefined): ProjectCard[] {
  // domain 装的是可空的 domain_id,消费端只拿它查 dcolor/dname/筛选项,
  // null 与空串在所有消费点行为一致,as string 只是满足旧壳形状的显式收窄。
  return (list || []).map(p => ({ ...p, id: p.slug, domain: p.domain_id as string, gaps: p.gaps || [], members: p.members || [] }));
}

// 拉首屏所需的全部数据。每个字段都带兜底(|| []/{}),任意一个接口失败都不能
// 阻止 store.ready 变 true —— 上一版 boot() 没做到这一点,直接把全站渲染成空壳。
// 课程卡片适配:后端给 instructors(复数,顿号分隔的署名串),而首页那条 strip 的
// 旧模板取的是 c.instructor(单数)、c.kind。用 track 顶掉已删除的 kind,
// 顺手把它变成真数据 —— 这一条 strip 因此不再是空壳。
export const TRACKS: Record<string, string> = {
  math: '数学基础', literacy: '人工智能通识',
  extension: '学科拓展', application: 'AI 编程与应用',
};
const cardifyCourses = (list: CourseCard[] | null | undefined): CourseCard[] =>
  (list || []).map(c => ({
    ...c, instructor: c.instructors || '', kind: c.track,
  }));

export async function boot() {
  const [me, domains, stats, settings] = await Promise.all([
    api('/auth/me').catch((): ApiResp => ({})),
    api('/domains').catch((): ApiResp => ({})),
    api('/stats').catch((): ApiResp => ({})),
    api('/settings/public').catch((): ApiResp => ({})),
  ]);
  store.user = (me && me.user) || null;
  store.domains = (domains && domains.domains) || [];
  store.dcolor = Object.fromEntries(store.domains.map(d => [d.id, d.color]));
  store.dname = Object.fromEntries(store.domains.map(d => [d.id, d.name]));
  store.stats = stats || {};
  store.registrationOpen = !!(settings && settings.registration_open);
  store.ready = true;
}

export async function login(username: string, password: string): Promise<ApiResp> {
  const r = await post('/auth/login', { username, password });
  if (r && r.ok) store.user = r.user || null;
  return r;
}

export async function logout(): Promise<ApiResp> {
  const r = await post('/auth/logout', {});
  store.user = null;
  return r;
}

export async function register(payload: Record<string, unknown>): Promise<ApiResp> {
  return await post('/auth/register', payload);
}

export async function refreshMe(): Promise<ApiResp> {
  const r = await api('/auth/me');
  store.user = (r && r.user) || null;
  return r;
}

// 需要"已登录"才能做的动作;未登录 → 提示并打开登录弹窗(取代已不存在的 #/login 页)。
// 返回 true 表示放行。取代旧的 requireMember(游客/身份组模型已随本任务整体删除)。
export function requireLogin(what = '操作'): boolean {
  if (!store.user) { toast(`请先登录再${what}`); openLogin(); return false; }
  return true;
}

// 项目详情是独立页面(非弹窗);id 现在装的是真实 slug。
export function openProject(id: string) { go('project/' + id); }

// 成员详情仍是抽屉(DrawerView 的展示逻辑原样保留)。id 现在装的是真实 username。
// 新的 /api/members/:username 只有 {id,username,display_name,bio,repo_url,created_at}
// 这几个真字段,远比旧演示数据(星阶/时区/语言/技能/关系网/成长值/作品集/时间线)单薄——
// 缺的字段一律兜底成空数组/占位值,DrawerView 模板里对应的 v-if 块会自动收起来,
// 不去编造假数据。
export async function openMember(id: string) {
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
      projects: (r.projects || []).map((p: any) => ({ id: p.slug, name: p.name, tagline: p.tagline, domain: p.domain_id, role: '' })),
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
export async function actFollow(): Promise<ApiResp> {
  if (!requireLogin('关注')) return { error: '请先登录' };
  return { error: '关注功能筹备中' };
}

// 项目关注:幂等开关。服务端按当前状态直接返回权威的 following/followers,
// 前端不用自己算"下一步该是什么",照抄响应即可——避免多标签页并发操作时
// 前端自己推算出的状态和数据库对不上("optimistic 但要对")。
export async function actProjectFollow(slug: string, follow?: boolean): Promise<ApiResp> {
  if (!requireLogin('关注项目')) return { error: '请先登录' };
  return await post(`/projects/${slug}/follow`, { follow });
}

// 申请加入:message 选填,后端会裁到 500 字并允许空。发起人给自己项目申请
// 会被服务端拒(400)——这里不重复校验,按钮本来就不会渲染给 owner 看。
export async function actProjectJoin(slug: string, message: string): Promise<ApiResp> {
  if (!requireLogin('申请加入')) return { error: '请先登录' };
  return await post(`/projects/${slug}/join`, { message: message || '' });
}

// 路演海报:上传 / 删除,只有 owner 或站长能改。后端已经把权限锁死了,这里
// 不重复判断——调用点(ProjectDetailPage 的 isOwnerOrAdmin)只对 owner/站长
// 渲染这两个按钮,别人根本点不到。
export async function actProjectPoster(slug: string, dataUrl: string): Promise<ApiResp> {
  if (!requireLogin('上传海报')) return { error: '请先登录' };
  return await post(`/projects/${slug}/poster`, { poster: dataUrl });
}
export async function actProjectPosterRemove(slug: string): Promise<ApiResp> {
  if (!requireLogin('移除海报')) return { error: '请先登录' };
  return await del(`/projects/${slug}/poster`);
}

// 加入申请队列:只有项目 owner 或站长能看/能处理,后端已鉴权,这里只是薄封装。
// ?status=pending:详情页的"待处理队列"只关心待处理项;端点默认仍全量返回
// (向后兼容),要待办队列的调用方传状态(C2 起)。返回 [列表, meta]。
export async function fetchJoinRequests(slug: string, status = 'pending') {
  const r = await api(`/projects/${slug}/join-requests?status=${status}`);
  return { list: (r && r.requests) || [], pagination: (r && r.pagination) || null };
}
// 端点是 /decision 不是 /decide,见 app/routes/projects.ts 顶部那条注释——
// 'decide' 是路由守卫里的保留动词,撞上会被强判成"仅站长",而这条端点的
// 真实权限是"owner 或站长"。
export async function actJoinRequestDecision(id: number, decision: string): Promise<ApiResp> {
  return await post(`/join-requests/${id}/decision`, { decision });
}

// 发起项目:接到真实的 POST /api/projects。旧表单字段名(domain/desc/repo)在这里
// 适配成新接口的字段名(domain_id/description/repo_url);founderId/stack/gaps 新接口
// 不认,直接丢弃 —— 发起人由服务端从登录会话推断,不再靠前端传参。
// 成功后重拉分页列表:新项目是 pending、本就不进公开列表,这次重拉对可见性是
// no-op,保留它只为维持"提交成功后列表与库一致"的语义。
export async function actPublishProject(body: Record<string, unknown>): Promise<ApiResp> {
  if (!requireLogin('发起项目')) return { error: '请先登录' };
  const r = await post('/projects', {
    name: body.name, tagline: body.tagline, description: body.desc,
    domain_id: body.domain || undefined, repo_url: body.repo || undefined,
    // 「技术栈」「正在找」这两个输入框在表单里一直存在,但此前提交时被丢掉,
    // 用户填了不报错、照样提示"已提交",值却不落库。现在接上真实字段。
    stack: body.stack, gaps: body.gaps,
  });
  if (r && r.ok && store.projectsState.loaded) {
    await refreshProjects();
  }
  return r;
}

// —— 项目列表(分页缓存)——
// ProjectsSection 是列表页主人:filters/page 变化时带参调用,翻页只换 page。
// loaded 标志:首次进页面才拉,二次进入用缓存;actPublishProject/actUpdateProject
// 成功后的重拉只在已加载过时执行,不会把首页时序搅进列表页。
export async function refreshProjects(opts: { page?: number; domain?: string; reset?: boolean } = {}) {
  const s = store.projectsState;
  if (opts.reset) {
    s.page = 1; s.domain = '';
  }
  if (opts.page !== undefined) s.page = opts.page;
  if (opts.domain !== undefined) s.domain = opts.domain;
  const params = new URLSearchParams();
  params.set('page', String(s.page));
  params.set('per_page', String(s.perPage));
  if (s.domain) params.set('domain', s.domain);
  const r = await api('/projects?' + params.toString());
  if (!r || r.error) return s;               // 失败保持旧数据,不让列表闪空
  s.list = cardifyProjects((r && r.projects) || []);
  s.pagination = r.pagination || s.pagination;
  s.domainCounts = (r && r.domain_counts) || {};
  s.loaded = true;
  return s;
}

// —— 课程中心 ——

// track/q/page 透传给服务端(?track= 服务端已支持,?q= 是 C1 的四字段 ILIKE);
// q 竞态保护:用一个自增号,晚发起的响应覆盖早发起的。
let coursesSeq = 0;
export async function refreshCourses(opts: { track?: string; q?: string; page?: number; perPage?: number } = {}): Promise<CourseCard[]> {
  const seq = ++coursesSeq;
  const params = new URLSearchParams();
  if (opts.track) params.set('track', opts.track);
  if (opts.q) params.set('q', opts.q);
  params.set('page', String(opts.page ?? 1));
  params.set('per_page', String(opts.perPage ?? 20));
  const r = await api('/courses?' + params.toString());
  if (seq !== coursesSeq) return store.courses;   // 已有更新的请求在途,丢弃旧响应
  store.courses = cardifyCourses(r && r.courses);
  store.coursesPagination = (r && r.pagination) || null;
  return store.courses;
}

export const fetchCourse = (slug: string): Promise<ApiResp> => api('/courses/' + encodeURIComponent(slug));

export async function actEnroll(slug: string, message?: string): Promise<ApiResp> {
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
// 成功后刷新分页缓存(改了名字/标语时,列表页缓存里还是旧值)。
export async function actUpdateProject(slug: string, body: Record<string, unknown>): Promise<ApiResp> {
  if (!requireLogin('编辑项目')) return { error: '请先登录' };
  const r = await patch('/projects/' + encodeURIComponent(slug), body);
  if (r && r.ok && store.projectsState.loaded) {
    await refreshProjects();
  }
  return r;
}
