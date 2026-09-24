<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { store, openProject, openMember, TRACKS } from '../store';
import { go } from '../../lib/router';
import { api, ago, STAGE } from '../../lib/api';
import { t } from '../../lib/i18n';
import Icon from '../../components/Icon.vue';
import HeroSection from '../sections/HeroSection.vue';

// 首页聚合预览:优先用后台「首页配置」选定的推荐项;未配置则按"最新/最热"规则筛精华
// (空壳 strip 的数据源是硬编码空值,排序键 activity/favorites 等恒 undefined → 全为 0,
//  行为等价:切片取前 N。any 是过渡态宽松,清壳时一并移除。)
const HOT: Record<string, (a: any, b: any) => number> = {
  projects: (a, b) => (b.activity || 0) - (a.activity || 0),        // 最热:近90天活跃
  courses: (a, b) => (b.favorites || 0) - (a.favorites || 0),       // 最热:收藏
  columns: (a, b) => (b.ts || 0) - (a.ts || 0),                     // 最新:发布时间
  activities: (a, b) => (a.ts || 0) - (b.ts || 0),                  // 最近:临近的活动
  students: (a, b) => (b.brightness || 0) - (a.brightness || 0),    // 最亮:近期活跃
  resources: (a, b) => (b.applied || 0) - (a.applied || 0),         // 最热:申请数
};
function pick(list: any[], key: string, n: number): any[] {
  const ids = (store.homeConfig.featured && store.homeConfig.featured[key]) || [];
  if (ids.length) {
    const byId = Object.fromEntries(list.map(x => [x.id, x]));
    const chosen = ids.map(id => byId[id]).filter(Boolean);
    if (chosen.length) return chosen.slice(0, n);
  }
  const s = HOT[key];
  return (s ? [...list].sort(s) : list).slice(0, n);
}
const projects = computed(() => pick(store.projects, 'projects', 4));
const courses = computed(() => pick(store.courses, 'courses', 4));
const columns = computed(() => pick(store.highlights.posts || [], 'columns', 3));
const activities = computed(() => pick(store.gatherings as any[], 'activities', 3));
const students = computed(() => pick(store.talent as any[], 'students', 4));
// 资源模块已随前端重写整体下线,新后端没有 /api/resources。这一条不再请求一个
// 必然 404 的端点,直接留空数组 —— 对应的"资源"strip 会照旧渲染,只是没有卡片。
const allRes = ref<any[]>([]);
const resources = computed(() => pick(allRes.value, 'resources', 4));

// 课程的分类维度是 track(数学基础/通识/学科拓展/编程应用),不再是旧的
// official/mentor/student —— 那三档在重写里随 kind 字段一起删了。
const KIND = TRACKS;
</script>

<template>
  <div class="home">
    <HeroSection />

    <!-- 项目 -->
    <section class="hstrip">
      <div class="wrap">
        <div class="strip-head">
          <h2>{{ t('正在进行的项目', 'Projects in progress') }}<span class="en">PROJECTS</span></h2>
          <a class="more" @click="go('projects')">{{ t('查看全部', 'See all') }} <Icon name="arrow" /></a>
        </div>
        <div class="strip-row c4">
          <a class="mini hoverable" v-for="p in projects" :key="p.id" @click="openProject(p.id)"
            :style="{ '--tc': store.dcolor[p.domain] }" role="button" tabindex="0">
            <span class="mini-dot" :style="{ background: store.dcolor[p.domain] }"></span>
            <div class="mini-title">{{ p.name }}</div>
            <div class="mini-sub">{{ p.tagline }}</div>
            <div class="mini-meta"><Icon name="pulse" /> {{ t('近90天', 'last 90d') }} {{ p.activity }} {{ t('次贡献', 'events') }}</div>
          </a>
        </div>
      </div>
    </section>

    <!-- 课程 -->
    <section class="hstrip alt">
      <div class="wrap">
        <div class="strip-head">
          <h2>{{ t('课程', 'Courses') }}<span class="en">COURSES</span></h2>
          <a class="more" @click="go('courses')">{{ t('查看全部', 'See all') }} <Icon name="arrow" /></a>
        </div>
        <div class="strip-row c4">
          <a class="mini hoverable" v-for="c in courses" :key="c.id" @click="go('courses')" role="button" tabindex="0">
            <div class="mini-title">{{ c.title }}</div>
            <div class="mini-sub">{{ c.instructor }}</div>
            <div class="mini-meta"><span class="tag">{{ KIND[c.kind] || c.kind }}</span></div>
          </a>
        </div>
      </div>
    </section>

    <!-- 约稿专栏 -->
    <section class="hstrip">
      <div class="wrap">
        <div class="strip-head">
          <h2>{{ t('约稿专栏', 'Columns') }}<span class="en">COLUMNS</span></h2>
          <a class="more" @click="go('columns')">{{ t('查看全部', 'See all') }} <Icon name="arrow" /></a>
        </div>
        <div class="strip-row c3">
          <a class="mini hoverable tall" v-for="c in columns" :key="c.id" @click="go('columns')" role="button" tabindex="0">
            <div class="mini-tag" v-if="c.column">{{ c.column }}</div>
            <div class="mini-sub" style="-webkit-line-clamp:3">{{ c.text }}</div>
            <div class="mini-meta"><Icon name="user" /> {{ c.author }}<span v-if="c.authorRoleLabel"> · {{ c.authorRoleLabel }}</span></div>
          </a>
        </div>
      </div>
    </section>

    <!-- 活动 -->
    <section class="hstrip alt">
      <div class="wrap">
        <div class="strip-head">
          <h2>{{ t('近期活动', 'Activities') }}<span class="en">ACTIVITIES</span></h2>
          <a class="more" @click="go('activities')">{{ t('查看全部', 'See all') }} <Icon name="arrow" /></a>
        </div>
        <div class="strip-row c3">
          <a class="mini hoverable" v-for="g in activities" :key="g.id" @click="go('activities')" role="button" tabindex="0">
            <div class="mini-title">{{ g.title }}</div>
            <div class="mini-sub">{{ g.host }}</div>
            <div class="mini-meta"><Icon name="clock" /> {{ g.whenLabel }} · {{ g.going }}/{{ g.capacity }} {{ t('已报名', 'joined') }}</div>
          </a>
        </div>
      </div>
    </section>

    <!-- 学生报道 -->
    <section class="hstrip">
      <div class="wrap">
        <div class="strip-head">
          <h2>{{ t('学生报道', 'Students') }}<span class="en">STUDENTS</span></h2>
          <a class="more" @click="go('mentors')">{{ t('查看全部', 'See all') }} <Icon name="arrow" /></a>
        </div>
        <div class="strip-row c4">
          <a class="mini hoverable" v-for="m in students" :key="m.id" @click="openMember(m.id)"
            :style="{ '--tc': store.dcolor[m.interests[0]] }" role="button" tabindex="0">
            <span class="mini-dot" :style="{ background: store.dcolor[m.interests[0]] }"></span>
            <div class="mini-title"><Icon name="star" :style="{ color: store.dcolor[m.interests[0]] }" /> {{ m.star }}</div>
            <div class="mini-sub">{{ t('擅长', 'skilled in') }} {{ m.skills.slice(0, 2).join('、') }}</div>
            <div class="mini-meta">{{ STAGE[m.stage] }} · <Icon name="bolt" /> {{ t('光度', 'lum') }} {{ m.brightness }}</div>
          </a>
        </div>
      </div>
    </section>

    <!-- 资源 -->
    <section class="hstrip alt">
      <div class="wrap">
        <div class="strip-head">
          <h2>{{ t('资源', 'Resources') }}<span class="en">RESOURCES</span></h2>
          <a class="more" @click="go('resources')">{{ t('查看全部', 'See all') }} <Icon name="arrow" /></a>
        </div>
        <div class="strip-row c4">
          <a class="mini hoverable" v-for="r in resources" :key="r.id" @click="go('resources')" role="button" tabindex="0">
            <div class="mini-title">{{ r.name }}</div>
            <div class="mini-sub">{{ r.providerName }}</div>
            <div class="mini-meta"><span class="tag">{{ r.kind }}</span> <span v-if="r.remaining != null" class="dim">{{ t('余', 'left') }} {{ r.remaining }} {{ r.unit }}</span></div>
          </a>
        </div>
      </div>
    </section>

    <div class="home-about">
      <a @click="go('about')">{{ t('关于我们 · 安全与治理 · 少年学院 · 为什么加入', 'About · Safety & Governance · Academy · Why Join') }} <Icon name="arrow" /></a>
    </div>
  </div>
</template>

<style scoped>
.hstrip { padding: 46px 0; }
.hstrip.alt { background: rgba(125, 180, 255, .028); }
.strip-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22px; }
.strip-head h2 { font-size: clamp(20px, 3vw, 28px); font-weight: 750; letter-spacing: .01em; }
.strip-head h2 .en { font-size: 11px; letter-spacing: .22em; color: var(--ink-3); margin-left: 10px; font-weight: 600; }
.more { font-size: 13px; color: var(--astral); cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.more:hover { color: var(--ink); }
.strip-row { display: grid; gap: 14px; }
.strip-row.c4 { grid-template-columns: repeat(4, 1fr); }
.strip-row.c3 { grid-template-columns: repeat(3, 1fr); }
.mini {
  position: relative; display: block; padding: 16px 16px 15px; border-radius: var(--radius);
  background: var(--surface); border: 1px solid var(--line); cursor: pointer; overflow: hidden;
  transition: transform var(--dur-1) var(--ease-out), border-color var(--dur-1) var(--ease-out);
}
.mini:hover { transform: translateY(-3px); border-color: var(--tc, var(--line-strong)); }
.mini.tall { min-height: 132px; }
.mini-dot { position: absolute; top: 0; left: 0; width: 100%; height: 3px; opacity: .85; }
.mini-tag { font-size: 11px; color: var(--polaris); letter-spacing: .04em; margin-bottom: 6px; }
.mini-title { font-size: 15px; font-weight: 680; display: flex; align-items: center; gap: 5px; }
.mini-sub { font-size: 12.5px; color: var(--ink-2); margin: 6px 0 10px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mini-meta { font-size: 11.5px; color: var(--ink-3); display: flex; align-items: center; gap: 5px; }
.mini-meta .tag { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line-strong); color: var(--ink-2); }
.home-about { text-align: center; padding: 40px 0 70px; }
.home-about a { color: var(--ink-3); font-size: 13.5px; cursor: pointer; }
.home-about a:hover { color: var(--astral); }
@media (max-width: 900px) {
  .strip-row.c4 { grid-template-columns: repeat(2, 1fr); }
  .strip-row.c3 { grid-template-columns: 1fr; }
}
</style>
