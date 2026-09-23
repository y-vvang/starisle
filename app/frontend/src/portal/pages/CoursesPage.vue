<script setup>
// #/courses —— 课程中心列表。
// 分类切换走服务端(?track=),关键词搜索在前端本地过滤 —— 列表本来就一次性
// 返回全部已发布课程,再为搜索多打一趟接口不值。
import { ref, computed, onMounted } from 'vue';
import { store, refreshCourses, TRACKS } from '../store';
import { go } from '../../lib/router';
import Icon from '../../components/Icon.vue';

const track = ref('');
const q = ref('');
const loading = ref(true);

const TABS = [['', '全部'], ...Object.entries(TRACKS)];

async function load() {
  loading.value = true;
  await refreshCourses(track.value);
  loading.value = false;
}
onMounted(load);

function pick(t) { track.value = t; load(); }

const visible = computed(() => {
  const kw = q.value.trim().toLowerCase();
  if (!kw) return store.courses;
  return store.courses.filter(c =>
    [c.title, c.subject, c.summary, c.instructors].some(
      v => v && String(v).toLowerCase().includes(kw)));
});

const hours = c => (c.total_hours == null ? '持续更新' : `${c.total_hours} 课时`);
</script>

<template>
  <!-- .page 本身没有样式(global.css 里没定义),左右边距一直是 .wrap 给的 ——
       只写 .page 会让整页贴到浏览器最左边。 -->
  <div class="page wrap">
    <div class="sec-head">
      <div>
        <div class="jm-kick">课程 · LEARNING PATHS</div>
        <h2>从一门真实的课程开始</h2>
        <p class="dim">课程由站长开设并审核发布。申请学习后由站长逐个开通。</p>
      </div>
      <button class="btn ghost" @click="go('my-courses')"><Icon name="scroll" /> 我的课程</button>
    </div>

    <div class="cs-tools">
      <div class="cs-tabs">
        <button v-for="[id, label] in TABS" :key="id"
                class="mode-tab" :class="{ on: track === id }" @click="pick(id)">{{ label }}</button>
      </div>
      <input class="cs-search" v-model="q" placeholder="搜课程名 / 方向 / 老师" />
    </div>

    <p v-if="loading" class="dim">载入中…</p>
    <p v-else-if="!visible.length" class="dim cs-empty">
      {{ q.trim() ? '没有匹配的课程。' : '这个分类下还没有已发布的课程。' }}
    </p>

    <div v-else class="grid c3">
      <a v-for="c in visible" :key="c.id" class="card cs-card hoverable"
         role="button" tabindex="0"
         @click="go('course/' + encodeURIComponent(c.slug))"
         @keydown.enter="go('course/' + encodeURIComponent(c.slug))">
        <div class="cs-top">
          <span class="badge">{{ TRACKS[c.track] || c.track }}</span>
          <span class="badge polaris" v-if="c.featured"><Icon name="star" /> 精选</span>
        </div>
        <h3 class="cs-title">{{ c.title }}</h3>
        <p class="cs-sum dim">{{ c.summary }}</p>
        <div class="cs-meta dim">
          <span v-if="c.instructors"><Icon name="user" /> {{ c.instructors }}</span>
          <span><Icon name="clock" /> {{ hours(c) }}</span>
          <span v-if="c.lesson_count"><Icon name="scroll" /> {{ c.lesson_count }} 节</span>
        </div>
        <div class="cs-go">查看课程 <Icon name="arrow" /></div>
      </a>
    </div>
  </div>
</template>

<style scoped>
/* 顶栏是固定定位的,页面内容必须自己让出这段高度 —— 与 ProjectDetailPage
   的 .pd-wrap { padding: 96px 24px 80px } 同一个数字。 */
.page { padding-top: 96px; padding-bottom: 80px; }
.sec-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin: 0 0 22px; }
.sec-head h2 { font-size: 30px; font-weight: 800; margin: 6px 0 8px; }
.cs-tools { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 22px; }
.cs-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
/* .mode-tab 是 JoinModal 的 scoped 类,不是全局的 —— 在这里要自己定义一份,
   否则渲染成浏览器默认的方框按钮。样式与那边保持一致。 */
.mode-tab { padding: 7px 16px; border-radius: 999px; border: 1px solid var(--line);
            background: transparent; color: var(--ink-3); font: inherit; font-size: 13px;
            font-weight: 600; cursor: pointer; transition: all .2s; }
.mode-tab:hover { color: var(--ink-2); border-color: var(--line-strong); }
.mode-tab.on { background: rgba(255, 210, 125, .14); border-color: var(--polaris); color: var(--polaris); }
.cs-search {
  margin-left: auto; min-width: 220px; flex: 0 1 280px;
  padding: 9px 14px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
}
.cs-empty { padding: 40px 0; }
.cs-card { display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
.cs-top { display: flex; gap: 8px; flex-wrap: wrap; }
.cs-title { font-size: 18px; font-weight: 700; margin: 2px 0; }
.cs-sum { font-size: 14px; line-height: 1.6; flex: 1; }
.cs-meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; }
.cs-meta span { display: inline-flex; align-items: center; gap: 5px; }
.cs-go { margin-top: 6px; font-size: 13px; font-weight: 600; color: var(--astral); }
</style>
