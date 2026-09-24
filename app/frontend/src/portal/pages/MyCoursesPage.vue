<script setup lang="ts">
// #/my-courses —— 我申请过的课程与状态。
import { ref, watch } from 'vue';
import { store, fetchMyCourses, requireLogin, TRACKS } from '../store';
import { go } from '../../lib/router';
import Icon from '../../components/Icon.vue';

// /api/my/courses 的行:course 卡片 + enrollment_status/enrollment_created_at
interface MyCourse {
  id: number; slug: string; title: string; summary: string | null;
  instructors: string | null; lesson_count?: number; track: string;
  enrollment_status: string; [key: string]: any;
}
const list = ref<MyCourse[]>([]);
const loading = ref(true);

async function load() {
  if (!store.user) { list.value = []; loading.value = false; return; }
  loading.value = true;
  list.value = await fetchMyCourses() as MyCourse[];
  loading.value = false;
}
watch(() => store.user, load, { immediate: true });

const LABEL: Record<string, string> = { pending: '审核中', approved: '可以学习', rejected: '未通过' };
</script>

<template>
  <div class="page wrap">
    <a class="pd-back" @click="go('courses')"><Icon name="back" /> 返回课程</a>

    <div class="mc-head">
      <div class="jm-kick">我的课程</div>
      <h2>你申请过的课</h2>
    </div>

    <div v-if="!store.user" class="pe-denied">
      <h2>先登录</h2>
      <p class="dim">登录之后这里会显示你申请过的课程和审核状态。</p>
      <button class="btn primary" @click="requireLogin('查看我的课程')">去登录</button>
    </div>

    <p v-else-if="loading" class="dim">载入中…</p>

    <div v-else-if="!list.length" class="pe-denied">
      <h2>还没有申请过课程</h2>
      <p class="dim">去课程中心看看有什么想学的。</p>
      <button class="btn ghost" @click="go('courses')"><Icon name="arrow" /> 浏览课程</button>
    </div>

    <div v-else class="grid c2">
      <a v-for="c in list" :key="c.id" class="card mc-card hoverable" role="button" tabindex="0"
         @click="go('course/' + encodeURIComponent(c.slug))"
         @keydown.enter="go('course/' + encodeURIComponent(c.slug))">
        <div class="mc-top">
          <span class="badge">{{ TRACKS[c.track] || c.track }}</span>
          <span class="mc-state" :class="'st-' + c.enrollment_status">
            {{ LABEL[c.enrollment_status] || c.enrollment_status }}
          </span>
        </div>
        <h3 class="cs-title">{{ c.title }}</h3>
        <p class="cs-sum dim">{{ c.summary }}</p>
        <div class="cs-meta dim">
          <span v-if="c.instructors"><Icon name="user" /> {{ c.instructors }}</span>
          <span v-if="c.lesson_count"><Icon name="scroll" /> {{ c.lesson_count }} 节</span>
        </div>
      </a>
    </div>
  </div>
</template>

<style scoped>
/* 顶栏是固定定位的,页面内容必须自己让出这段高度 —— 与 ProjectDetailPage
   的 .pd-wrap { padding: 96px 24px 80px } 同一个数字。 */
.page { padding-top: 96px; padding-bottom: 80px; }
.pd-back { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3);
           font-size: 13.5px; cursor: pointer; margin-bottom: 20px; }
.pd-back:hover { color: var(--astral); }
.pe-denied { padding: 60px 0; text-align: center; }
.pe-denied h2 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
.pe-denied p { margin-bottom: 20px; }
.mc-head { margin: 16px 0 22px; }
.mc-head h2 { font-size: 28px; font-weight: 800; margin-top: 6px; }
.mc-card { display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
.mc-top { display: flex; align-items: center; gap: 8px; }
.mc-state { margin-left: auto; font-size: 12px; padding: 3px 10px; border-radius: 999px;
            border: 1px solid var(--line); }
.st-approved { color: #1f7a4d; border-color: rgba(31,122,77,.35); background: rgba(31,122,77,.07); }
.st-pending  { color: var(--polaris); border-color: rgba(194,137,27,.35); background: rgba(194,137,27,.07); }
.st-rejected { color: #b3261e; border-color: rgba(179,38,30,.3); background: rgba(179,38,30,.06); }
.cs-title { font-size: 17px; font-weight: 700; }
.cs-sum { font-size: 13.5px; line-height: 1.6; flex: 1; }
.cs-meta { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; }
.cs-meta span { display: inline-flex; align-items: center; gap: 5px; }
</style>
