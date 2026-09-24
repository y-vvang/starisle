<script setup lang="ts">
// #/course/:slug —— 课程详情:简介 + 课纲 + 申请学习。
// 课纲对所有人可见(包括匿名),申请学习需要登录。课件不在本次范围,所以课节只到
// 标题/摘要/时长为止,没有"开始学习"入口 —— 与其摆一个点不动的按钮,不如不摆。
import { ref, computed, watch } from 'vue';
import { store, fetchCourse, actEnroll, TRACKS } from '../store';
import { router, go } from '../../lib/router';
import Icon from '../../components/Icon.vue';

const c = ref<any>(null);
const lessons = ref<any[]>([]);
const enrollment = ref<any>(null);
const loading = ref(true);
const busy = ref(false);

async function load() {
  if (!router.param) return;
  loading.value = true;
  const r = await fetchCourse(router.param);
  loading.value = false;
  if (!r || r.error || !r.course) { c.value = null; return; }
  c.value = r.course;
  lessons.value = r.lessons || [];
  enrollment.value = r.enrollment || null;
}
// store.user 要等 boot() 拉完 /auth/me 才有值 —— 只看 router.param 会在未登录态
// 下先渲染一次"尚未申请",登录信息到位后又不刷新。
watch([() => router.param, () => store.user], load, { immediate: true });

const state = computed(() => {
  // 课纲还没排就别摆申请按钮 —— 服务端也会挡(409),这里只是不给一个注定失败的按钮。
  if (!lessons.value.length) return { key: 'nolesson', label: '课纲整理中', badge: '课纲整理中', can: false };
  if (!store.user) return { key: 'anon', label: '申请学习', badge: '尚未申请', can: true };
  const s = enrollment.value && enrollment.value.status;
  if (s === 'approved') return { key: 'approved', label: '学习权限已开通', badge: '已开通', can: false };
  if (s === 'pending')  return { key: 'pending',  label: '申请审核中',     badge: '审核中', can: false };
  if (s === 'rejected') return { key: 'rejected', label: '重新申请',       badge: '未通过', can: true };
  return { key: 'none', label: '申请学习', badge: '尚未申请', can: true };
});

async function apply() {
  if (!c.value) return;
  // 不要写成 prompt(...) || '' —— 那会把"点了取消"(null)和"留空提交"('')
  // 混成一件事,用户按取消照样会提交。
  const message = window.prompt('想跟站长说点什么?(可留空)');
  if (message === null) return;
  busy.value = true;
  const r = await actEnroll(c.value.slug, message);
  busy.value = false;
  if (r && r.enrollment) enrollment.value = r.enrollment;
  else await load();   // 409 之类:以服务端为准重新拉一次,别让按钮停在错的状态
}

const dur = (l: any) => (l.duration_minutes ? `${l.duration_minutes} 分钟` : '专题');
const hours = () => (c.value.total_hours == null ? '持续更新' : `${c.value.total_hours} 课时`);
</script>

<template>
  <div class="page wrap">
    <a class="pd-back" @click="go('courses')"><Icon name="back" /> 返回课程</a>

    <p v-if="loading" class="dim">载入中…</p>

    <div v-else-if="!c" class="pe-denied">
      <h2>找不到这门课</h2>
      <p class="dim">它可能还没发布,或者已经下架了。</p>
      <button class="btn ghost" @click="go('courses')"><Icon name="back" /> 去课程列表</button>
    </div>

    <template v-else>
      <div class="cd-hero card">
        <div class="cs-top">
          <span class="badge">{{ TRACKS[c.track] || c.track }}</span>
          <span class="badge polaris" v-if="c.featured"><Icon name="star" /> 精选</span>
          <span class="badge" v-if="c.subject">{{ c.subject }}</span>
        </div>
        <h1 class="cd-title">{{ c.title }}</h1>
        <p class="cd-desc">{{ c.description || c.summary }}</p>
        <div class="cd-facts dim">
          <span v-if="c.instructors"><Icon name="user" /> {{ c.instructors }}</span>
          <span><Icon name="clock" /> {{ hours() }}</span>
          <span><Icon name="scroll" /> {{ lessons.length }} 节</span>
        </div>
      </div>

      <div class="cd-body">
        <section class="cd-main">
          <h3>课纲</h3>
          <p v-if="!lessons.length" class="dim cd-nolesson">课纲还在整理中。</p>
          <ol v-else class="cd-lessons">
            <li v-for="l in lessons" :key="l.id" class="card cd-lesson">
              <div class="cd-l-head">
                <span class="cd-l-no">{{ String(l.position).padStart(2, '0') }}</span>
                <span class="cd-l-title">{{ l.title }}</span>
                <span class="cd-l-dur dim">{{ dur(l) }}</span>
              </div>
              <p v-if="l.summary" class="dim cd-l-sum">{{ l.summary }}</p>
            </li>
          </ol>
        </section>

        <aside class="cd-side">
          <div class="card cd-apply">
            <h3>加入课程学习</h3>
            <div class="cd-state" :class="'st-' + state.key">
              <Icon :name="state.key === 'approved' ? 'check' : state.key === 'pending' ? 'clock' : 'star'" />
              <span>{{ state.badge }}</span>
            </div>
            <button class="btn primary wide" :disabled="busy || !state.can" @click="apply">
              {{ busy ? '提交中…' : state.label }}
            </button>
            <p class="dim cd-hint" v-if="c.audience"><b>适合人群</b><br />{{ c.audience }}</p>
            <p class="dim cd-hint">
              课件与录播暂未开放,当前可以看到完整课纲。申请通过后站长会另行通知学习安排。
            </p>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 顶栏是固定定位的,页面内容必须自己让出这段高度 —— 与 ProjectDetailPage
   的 .pd-wrap { padding: 96px 24px 80px } 同一个数字。 */
.page { padding-top: 96px; padding-bottom: 80px; }
/* .pd-back / .pe-denied 都是别的页面的 scoped 类,这里要各自带一份。 */
.pd-back { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3);
           font-size: 13.5px; cursor: pointer; margin-bottom: 20px; }
.pd-back:hover { color: var(--astral); }
.pe-denied { padding: 60px 0; text-align: center; }
.pe-denied h2 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
.pe-denied p { margin-bottom: 20px; }
.cd-hero { margin: 14px 0 22px; }
.cd-title { font-size: 30px; font-weight: 800; margin: 10px 0 10px; }
.cd-desc { color: var(--ink-2); line-height: 1.75; max-width: 70ch; }
.cd-facts { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; font-size: 13px; }
.cd-facts span { display: inline-flex; align-items: center; gap: 6px; }
.cd-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 22px; align-items: start; }
.cd-main h3, .cd-apply h3 { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
.cd-nolesson { padding: 24px 0; }
.cd-lessons { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.cd-lesson { padding: 14px 16px; }
.cd-l-head { display: flex; align-items: baseline; gap: 10px; }
.cd-l-no { font-weight: 800; color: var(--polaris); font-size: 13px; }
.cd-l-title { font-weight: 600; flex: 1; }
.cd-l-dur { font-size: 12.5px; }
.cd-l-sum { font-size: 13.5px; margin-top: 6px; line-height: 1.6; }
.cd-side { position: sticky; top: 84px; }
.cd-state { display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
            padding: 5px 12px; border-radius: 999px; margin-bottom: 14px;
            border: 1px solid var(--line); }
.st-approved { color: #1f7a4d; border-color: rgba(31,122,77,.35); background: rgba(31,122,77,.07); }
.st-pending  { color: var(--polaris); border-color: rgba(194,137,27,.35); background: rgba(194,137,27,.07); }
.st-rejected { color: #b3261e; border-color: rgba(179,38,30,.3); background: rgba(179,38,30,.06); }
.cd-hint { font-size: 12.5px; line-height: 1.65; margin-top: 14px; }
@media (max-width: 900px) { .cd-body { grid-template-columns: 1fr; } .cd-side { position: static; } }
</style>
