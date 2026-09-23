<script setup>
import { computed, onMounted, ref } from 'vue';
import { store, boot, closeDrawer, closeWorkbench, openJoin, openLogin, closeJoin } from './store';
import { router, go } from '../lib/router';
import { initCursorLight } from '../lib/api';
import { i18n, toggleLang, t } from '../lib/i18n';
import Icon from '../components/Icon.vue';
import HomePage from './pages/HomePage.vue';
import ProjectsPage from './pages/ProjectsPage.vue';
import ProjectDetailPage from './pages/ProjectDetailPage.vue';
import ProjectEditPage from './pages/ProjectEditPage.vue';
import CoursesPage from './pages/CoursesPage.vue';
import CourseDetailPage from './pages/CourseDetailPage.vue';
import MyCoursesPage from './pages/MyCoursesPage.vue';
import MentorsPage from './pages/MentorsPage.vue';
import JoinModal from './sections/JoinModal.vue';
import DrawerView from './sections/DrawerView.vue';
import IdentityRibbon from './sections/IdentityRibbon.vue';

const scrolled = ref(false);
const progress = ref(0);
const menuOpen = ref(false);

boot();

const PAGES = {
  '': HomePage,
  projects: ProjectsPage,
  project: ProjectDetailPage,
  courses: CoursesPage,
  course: CourseDetailPage,
  'my-courses': MyCoursesPage,
  mentors: MentorsPage,
};
// #/project/:slug/edit 走编辑页;其余第三段一律忽略,落回详情页。
const pageComp = computed(() =>
  (router.page === 'project' && router.sub === 'edit') ? ProjectEditPage
    : (PAGES[router.page] || HomePage));

const NAV = [
  ['projects', '项目', 'Projects'],
  ['courses', '课程', 'Courses'],
  ['mentors', '导师', 'Mentors'],
];

// 深层页面也要点亮对应的一级导航 —— 站在项目详情页时"项目"应该是亮的。
// (这条顺带修了项目详情/编辑页导航不高亮的老毛病。)
const NAV_ALIAS = { project: 'projects', course: 'courses', 'my-courses': 'courses' };
const navActive = id => router.page === id || NAV_ALIAS[router.page] === id;

function nav(page) { menuOpen.value = false; go(page); }

onMounted(() => {
  initCursorLight();
  window.addEventListener('scroll', () => {
    scrolled.value = scrollY > 30;
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.value = max > 0 ? (scrollY / max) * 100 : 0;
  }, { passive: true });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeDrawer(); closeWorkbench(); closeJoin(); menuOpen.value = false; }
  });
});
</script>

<template>
  <div>
    <header class="nav" :class="{ scrolled }">
      <div class="nav-inner">
        <a class="logo" href="#/" @click.prevent="nav('')"><Icon name="star" class="mark" /> 星屿 <span class="en">STARISLE</span></a>
        <nav class="nav-links">
          <a v-for="l in NAV" :key="l[0]" href="#" @click.prevent="nav(l[0])" :class="{ now: navActive(l[0]) }">{{ t(l[1], l[2]) }}</a>
          <button class="lang-btn" @click="toggleLang" :aria-label="t('切换到英文', 'Switch to Chinese')">{{ i18n.lang === 'zh' ? 'EN' : '中' }}</button>
          <template v-if="!store.user">
            <a href="#" @click.prevent="openLogin">{{ t('登录', 'Log in') }}</a>
            <a v-if="store.registrationOpen" href="#" class="cta" @click.prevent="openJoin()">{{ t('加入', 'Join') }}</a>
            <span v-else class="reg-closed">{{ t('暂未开放注册', 'Applications closed') }}</span>
          </template>
        </nav>
        <button class="nav-burger" :class="{ open: menuOpen }" @click="menuOpen = !menuOpen" aria-label="菜单" :aria-expanded="menuOpen" aria-controls="mobile-nav">
          <span></span><span></span><span></span>
        </button>
        <div class="nav-progress" :style="{ width: progress + '%' }"></div>
      </div>
      <div id="mobile-nav" class="nav-sheet" :class="{ open: menuOpen }" aria-label="移动导航">
        <a v-for="l in NAV" :key="l[0]" href="#" @click.prevent="nav(l[0])">{{ t(l[1], l[2]) }}</a>
        <a href="#" @click.prevent="toggleLang">{{ i18n.lang === 'zh' ? 'English' : '切换中文' }}</a>
        <template v-if="!store.user">
          <a href="#" @click.prevent="menuOpen = false; openLogin()">{{ t('登录', 'Log in') }}</a>
          <a v-if="store.registrationOpen" href="#" class="sheet-cta" @click.prevent="menuOpen = false; openJoin()">{{ t('加入', 'Join') }}</a>
          <span v-else class="sheet-reg-closed">{{ t('暂未开放注册', 'Applications closed') }}</span>
        </template>
      </div>
    </header>
    <div class="nav-sheet-mask" :class="{ open: menuOpen }" @click="menuOpen = false"></div>

    <main class="route-outlet">
      <component :is="pageComp" :key="router.page" />
    </main>

    <footer class="footer">
      <div class="wrap cols">
        <div class="foot-note">
          <div class="logo" style="margin-bottom:14px"><Icon name="star" class="mark" /> 星屿</div>
          <p>干活在私域(gitee),展示在星空。代码/文档/Issue 在 Gitee,平台管身份、关系、资源与成果;所有内容经数据最小化脱敏与人工终审。未成年人安全高于一切功能。</p>
        </div>
        <div>
          <h5>浏览</h5>
          <a href="#" @click.prevent="nav('projects')">项目</a>
        </div>
      </div>
    </footer>

    <DrawerView />
    <IdentityRibbon />
    <JoinModal />
  </div>
</template>

<style scoped>
.route-outlet { min-height: 60vh; }
.lang-btn {
  margin-left: 6px; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line-strong);
  background: rgba(125, 180, 255, .06); color: var(--ink-2); font: inherit; font-size: 12px; font-weight: 600;
  cursor: pointer; transition: all var(--dur-1, .2s) var(--ease-out, ease);
}
.lang-btn:hover { border-color: var(--astral); color: var(--ink); }
.lang-btn:active { transform: scale(.94); }
@media (max-width: 860px) { .lang-btn { display: none; } }
.reg-closed { font-size: 12.5px; color: var(--ink-3); margin-left: 4px; white-space: nowrap; }
.sheet-reg-closed { padding: 12px 24px; font-size: 13px; color: var(--ink-3); }
.nav-burger {
  display: none; flex-direction: column; justify-content: center; gap: 5px;
  width: 40px; height: 40px; border: 1px solid var(--line-strong); border-radius: 10px;
  background: rgba(125, 180, 255, .06); cursor: pointer; margin-left: 12px; padding: 0 9px;
}
.nav-burger span { display: block; height: 2px; width: 100%; background: var(--ink); border-radius: 2px;
  transition: transform var(--dur-1, .2s) var(--ease-out, ease), opacity var(--dur-1, .2s) var(--ease-out, ease); }
.nav-burger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
.nav-burger.open span:nth-child(2) { opacity: 0; }
.nav-burger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
.nav-sheet {
  overflow: hidden; max-height: 0; opacity: 0;
  transition: max-height .34s var(--ease-out, ease), opacity .28s var(--ease-out, ease);
  display: flex; flex-direction: column;
  background: var(--glass); backdrop-filter: blur(24px) saturate(180%);
  border-bottom: 1px solid var(--line);
  overscroll-behavior: contain; padding-bottom: env(safe-area-inset-bottom);
}
.nav-sheet.open { max-height: calc(100dvh - 58px - env(safe-area-inset-top)); opacity: 1; overflow-y: auto; }
.nav-sheet a {
  min-height: 48px; display: flex; align-items: center;
  padding: 12px 24px; font-size: 16px; color: var(--ink-2); border-bottom: 1px solid var(--line);
}
.nav-sheet a:active { background: rgba(125, 180, 255, .1); }
.nav-sheet a.sheet-cta { color: var(--polaris); font-weight: 700; border-bottom: 0; }
.nav-sheet-mask {
  position: fixed; inset: 0; z-index: 80; background: rgba(20, 30, 52, .38);
  opacity: 0; pointer-events: none; transition: opacity .3s;
}
.nav-sheet-mask.open { opacity: 1; pointer-events: auto; }
@media (max-width: 860px) { .nav-burger { display: flex; } }
@media (min-width: 861px) { .nav-sheet, .nav-sheet-mask { display: none; } }
</style>
