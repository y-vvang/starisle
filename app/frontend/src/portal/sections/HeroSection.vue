<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { store, openJoin } from '../store';
import { go } from '../../lib/router';
import { countUp } from '../../lib/api';
import { t } from '../../lib/i18n';
import Icon from '../../components/Icon.vue';

// 模板里 :ref 回调推送的是 Element | ComponentPublicInstance | null(vue 的
// ref 回调签名),收宽成 any[] 承载
const statsEls = ref<any[]>([]);

// /api/stats 目前只返回 { members, projects } 两个真实数字;"本月共创产出"/
// "国家·地区" 这两块没有对应后端字段。与其把 undefined 兜底成写死的 0
// (0 会读成"这个社区什么都没做出来",比不展示更糟),这里干脆不渲染这两块 tile。
const heroStats = (): [number | undefined, string][] => [
  [store.stats.members, t('成员', 'members')],
  [store.stats.projects, t('在做的项目', 'projects')],
];

// 银河图与跑马灯/新闻轮播已随前端重写移除;首屏只保留文案 + 加入入口。
const VISITOR_COPY = { h: '和优秀的同龄人,一起做真实项目', d: '一个有准入门槛、以真实作品说话的国际青少年 AI 开发者社区。代码在 Gitee,身份、关系与成果在这里。', a1: ['浏览项目', () => go('projects')] as [string, () => void], a2: ['申请加入', () => openJoin()] as [string, () => void] };

const heroCopy = computed(() => {
  const hc = store.homeConfig || { heroTitle: '', heroDesc: '', featured: {} };
  return { ...VISITOR_COPY, h: hc.heroTitle || VISITOR_COPY.h, d: hc.heroDesc || VISITOR_COPY.d };
});

// 统计数字滚动:store.stats 到位后再触发(去重,防重渲染重复收集)
watch(() => store.stats, async v => {
  if (!v) return;
  await nextTick();
  requestAnimationFrame(() => {
    [...new Set(statsEls.value)].forEach(el => el && countUp(el, (el as HTMLElement).dataset.n));
    statsEls.value = [];
  });
}, { immediate: true });
</script>

<template>
  <section class="hero" id="top">
    <div class="hero-veil"></div>

    <div class="hero-copy">
      <div class="hero-kicker">星屿 · STARISLE</div>
      <h1 class="hero-title">{{ heroCopy.h }}</h1>
      <p class="hero-desc">{{ heroCopy.d }}</p>
      <div class="hero-actions">
        <a class="btn primary" href="#" @click.prevent="heroCopy.a1[1]()"><Icon name="planet" /> {{ heroCopy.a1[0] }}</a>
        <a v-if="store.registrationOpen" class="btn ghost" href="#" @click.prevent="heroCopy.a2[1]()">{{ heroCopy.a2[0] }}</a>
      </div>
      <p class="hero-closed-note" v-if="!store.registrationOpen">{{ t('报名暂未开放,请留意后续开放时间。', 'Applications are currently closed — check back later.') }}</p>
      <div class="hero-stats" v-if="store.stats">
        <div class="hstat" v-for="([n, l], i) in heroStats()" :key="i">
          <div class="num"><em :data-n="n" :ref="el => el && statsEls.push(el)">0</em></div>
          <div class="lbl">{{ l }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero { height: 78vh; min-height: 540px; position: relative; }
.hero-veil {
  position: absolute; inset: 0;
  background:
    linear-gradient(105deg, rgba(244,246,251,.96) 0%, rgba(244,246,251,.84) 40%, rgba(244,246,251,.6) 70%, rgba(244,246,251,.3) 100%),
    linear-gradient(to bottom, transparent 62%, var(--bg) 100%);
}
.hero-closed-note { margin-top: 16px; font-size: 13.5px; color: var(--ink-3); }
</style>
