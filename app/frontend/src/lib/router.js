import { reactive } from 'vue';

// 极简哈希路由:#/ 首页,#/projects 列表,#/project/:slug 详情,#/members 列表,
// #/u/:username 个人主页,#/login #/register #/me 账号相关页。无依赖。
const ROUTES = ['', 'projects', 'project', 'courses', 'course', 'my-courses',
                'mentors', 'members', 'u', 'login', 'register', 'me'];

function parse() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/');
  const seg = ROUTES.includes(parts[0]) ? parts[0] : '';
  // sub 是第三段,目前只用于 #/project/:slug/edit。项目 slug 可能含中文
  // (uniqueSlug 保留 CJK),hash 里是 percent-encoded,取出来要解码;
  // decodeURIComponent 遇到 %zz 这类畸形输入会抛,兜底成原串而不是让路由炸掉。
  const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
  return { page: seg, param: dec(parts[1] || ''), sub: parts[2] || '' };
}

export const router = reactive(parse());

window.addEventListener('hashchange', () => {
  const p = parse();
  const changed = p.page !== router.page || p.param !== router.param || p.sub !== router.sub;
  router.page = p.page;
  router.param = p.param;
  router.sub = p.sub;
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
});

// go('projects') → #/projects,go('project/p-lumen') → #/project/p-lumen,go('') → #/
export function go(path) {
  location.hash = path ? '#/' + path : '#/';
}
