<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, reactive, ref } from 'vue';
import type { Component, Ref } from 'vue';
import { api, post, initCursorLight } from '../lib/api';
import type { ApiResp } from '../lib/api';
import Icon from '../components/Icon.vue';
import UserReviewPage from './pages/UserReviewPage.vue';
import ProjectsReviewPage from './pages/ProjectsReviewPage.vue';
import MembersPage from './pages/MembersPage.vue';
import SiteSettingsPage from './pages/SiteSettingsPage.vue';
import CoursesAdminPage from './pages/CoursesAdminPage.vue';
import MentorReviewPage from './pages/MentorReviewPage.vue';

/* 鉴权:后台不再有独立的运营口令,直接复用主站同一套 HttpOnly cookie 会话
   (见 lib/api.ts:api() 的 credentials:'same-origin')。登录卡打真实的
   POST /api/auth/login;拿到会话后再打一次 GET /api/auth/me,显式校验
   user.role==='admin'——不能只信"登录成功",一个普通成员一样能登录成功。
   服务端确实会在每个 /api/admin/* 请求上再拒一次这类用户,但控制台自己
   不该摆一堆注定 403 的审核按钮出来,所以这里独立做一次角色判断,把这类
   账号挡在"站长专属"的提示页,不进四页控制台。 */
const me = ref<any>(null);
const checking = ref(true);
const username = ref('');
const password = ref('');
const loginErr = ref('');
const busy = ref(false);
const clock = ref('');

const shared = reactive<{ dname: Record<string, string>; dcolor: Record<string, string> }>({ dname: {}, dcolor: {} });
provide('shared', shared);
// 成员管理页要知道"我自己"是谁,以便隐藏对自己账号的停用按钮
// (服务端也会拒,见 users.ts 的 id===ctx.user.id 检查,这里只是不摆出一个
// 注定失败的按钮)。id 是 number —— app/db/pool.ts 给 bigint(OID 20)注册了
// Number 类型解析器,从 pg 出来就是数字;这里两边同源,直接 === 比。
provide('me', me);

const NAV: readonly [string, string, string][] = [
  ['users', '待审用户', 'user'],
  ['projects', '待审项目', 'planet'],
  ['courses', '课程管理', 'scroll'],
  ['mentors', '导师申请', 'link'],
  ['members', '成员管理', 'team'],
  ['settings', '站点设置', 'gear'],
];
const PAGES: Record<string, Component> = { users: UserReviewPage, projects: ProjectsReviewPage, courses: CoursesAdminPage, mentors: MentorReviewPage, members: MembersPage, settings: SiteSettingsPage };
const page = ref('users');
function go(id: string) { page.value = id; location.hash = id; }

// 项目审核页要按 domain_id 显示领域名/配色,这里统一拉一次喂给它,
// 避免每个子页各自重复请求。
async function loadDomains() {
  const r = await api('/domains');
  const list = (r && r.domains) || [];
  shared.dname = Object.fromEntries(list.map((d: any) => [d.id, d.name]));
  shared.dcolor = Object.fromEntries(list.map((d: any) => [d.id, d.color]));
}

// 侧栏待办角标。进后台时拉一次,以及每次在后台里做完一个动作后由子页面自己刷新自己 ——
// **刻意不做轮询**:本项目主站的通知铃铛也是不轮询的(见 docs/API.md),后台再引一个
// 定时器会多出一条需要在 onUnmounted 里收尾的生命周期,收益不抵复杂度。
const badges = reactive<Record<string, number>>({ users: 0, projects: 0, courses: 0, mentors: 0 });
const len = (r: unknown): number => (Array.isArray(r) ? r.length : 0);
async function refreshBadges() {
  const [u, p, ce, mr] = await Promise.all([
    api('/admin/users/pending').catch((): ApiResp => ({})),
    api('/admin/projects/pending').catch((): ApiResp => ({})),
    api('/admin/course-enrollments?status=pending').catch((): ApiResp => ({})),
    api('/admin/mentor-requests?status=pending').catch((): ApiResp => ({})),
  ]);
  badges.users = len(u && u.users);
  badges.projects = len(p && p.projects);
  badges.courses = len(ce && ce.requests);
  badges.mentors = len(mr && mr.requests);
}

async function refreshMe(): Promise<any> {
  const r = await api('/auth/me');
  me.value = (r && r.user) || null;
  if (me.value && me.value.role === 'admin') {
    await loadDomains();
    await refreshBadges();
  }
  return me.value;
}

async function doLogin() {
  loginErr.value = '';
  if (!username.value.trim() || !password.value) return;
  busy.value = true;
  const r = await post('/auth/login', { username: username.value.trim(), password: password.value });
  busy.value = false;
  if (!r || r.error) { loginErr.value = (r && r.error) || '登录失败'; return; }
  password.value = '';
  await refreshMe();
}

async function doLogout() {
  await post('/auth/logout', {});
  me.value = null;
}

// 会话在使用过程中失效(过期 / 被停用 / 另一个标签页登出)时,lib/api.ts 的
// api() 会广播这个事件——统一在这里退回登录卡,不必每个页面自己盯着 401。
function onUnauthorized() { me.value = null; }

onMounted(async () => {
  initCursorLight();
  const tick = () => {
    const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
    clock.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick(); setInterval(tick, 1000);
  window.addEventListener('starisle:unauthorized', onUnauthorized);
  const initial = location.hash.slice(1);
  if (PAGES[initial]) page.value = initial;
  await refreshMe();
  checking.value = false;
});
onBeforeUnmount(() => window.removeEventListener('starisle:unauthorized', onUnauthorized));
</script>

<template>
  <div class="login-wrap" v-if="checking">
    <div class="login-card">
      <div class="login-logo"><Icon name="star" class="mark" /> 星屿控制台</div>
      <p class="login-hint">校验登录状态…</p>
    </div>
  </div>

  <div class="login-wrap" v-else-if="!me">
    <form class="login-card" @submit.prevent="doLogin">
      <div class="login-logo"><Icon name="star" class="mark" /> 星屿控制台</div>
      <p class="login-hint">这里是站长后台,用你的星屿账号登录。</p>
      <input type="text" v-model="username" placeholder="用户名" autocomplete="username" autofocus />
      <input type="password" v-model="password" placeholder="密码" autocomplete="current-password" />
      <button class="btn" type="submit" :disabled="busy || !username.trim() || !password">{{ busy ? '登录中…' : '登录' }}</button>
      <p class="login-err" v-if="loginErr">{{ loginErr }}</p>
      <a class="login-back" href="/"><Icon name="back" /> 返回公开主站</a>
    </form>
  </div>

  <div class="login-wrap" v-else-if="me.role !== 'admin'">
    <div class="login-card">
      <div class="login-logo"><Icon name="shield" class="mark" /> 星屿控制台</div>
      <p class="login-hint">你已登录为 <b>{{ me.display_name || me.username }}</b>,但这里是站长专属的运营后台,你的账号没有站长权限。</p>
      <button class="btn ghost" type="button" @click="doLogout"><Icon name="back" /> 退出登录</button>
      <a class="login-back" href="/"><Icon name="back" /> 返回公开主站</a>
    </div>
  </div>

  <div class="admin-shell" v-else>
    <aside class="admin-side">
      <a class="logo" href="/"><Icon name="star" class="mark" /> 星屿控制台</a>
      <nav>
        <a v-for="[id, label, icon] in NAV" :key="id" href="#"
          :class="{ active: page === id }" @click.prevent="go(id)">
          <Icon :name="icon" /> {{ label }}
          <span class="nav-badge" v-if="badges[id]">{{ badges[id] }}</span>
        </a>
      </nav>
      <a class="back" href="/"><Icon name="back" /> 返回公开主站</a>
    </aside>

    <main class="admin-main">
      <div class="admin-top">
        <span class="duty-chip"><Icon name="user" /> 站长 · <b>{{ me.display_name || me.username }}</b></span>
        <span class="live-chip"><span class="live-dot"></span><Icon name="db" /> 已连接</span>
        <span class="clock">{{ clock }}</span>
        <button class="btn small ghost" style="margin-left:auto" @click="doLogout"><Icon name="back" /> 退出</button>
      </div>
      <component :is="PAGES[page] || UserReviewPage" :key="page" />
    </main>
  </div>
</template>

<style scoped>
/* 侧栏待办角标。写在这里而不是 global.css:它只服务于本组件的 nav。
   .admin-side nav a 是 flex,所以用 margin-left:auto 把角标推到最右。 */
.nav-badge {
  margin-left: auto;
  min-width: 18px; padding: 0 6px; border-radius: 999px;
  font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
  color: #241a05; background: var(--polaris);
}

.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.login-card { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; padding: 28px 26px 22px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); box-shadow: 0 18px 50px rgba(20,30,60,.10); }
.login-logo { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; }
.login-hint { margin: 0; font-size: 13px; color: var(--ink-3); line-height: 1.6; }
.login-card input { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--bg); color: var(--ink); font: inherit; }
.login-card .btn { justify-content: center; }
.login-err { margin: 0; font-size: 12.5px; color: #c2413a; }
.login-back { font-size: 12.5px; color: var(--ink-3); display: inline-flex; align-items: center; gap: 5px; }
</style>
