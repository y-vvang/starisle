<script setup lang="ts">
// 通用分页条:页码 + 上一页/下一页 + 「共 N 条」。
// 页面只负责把 props 传进来、在 change 时重拉自己的列表;
// 上一页/下一页的边界由 disabled 表达,不夹内部状态。
import { computed } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  page: number;
  perPage: number;
  total: number;
}>();
const emit = defineEmits<{ change: [page: number] }>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.perPage)));
// 页码按钮:数据量大时只亮一个数字也不碍事(这个站的数据量级不需要窗口化)
const pageList = computed(() => Array.from({ length: totalPages.value }, (_, i) => i + 1));

function go(p: number) {
  if (p < 1 || p > totalPages.value || p === props.page) return;
  emit('change', p);
}
</script>

<template>
  <nav class="pagebar" v-if="total > 0">
    <button class="pb-arrow" :disabled="page <= 1" @click="go(page - 1)" aria-label="上一页">
      <Icon name="back" />
    </button>
    <button class="pb-num" v-for="n in pageList" :key="n" :class="{ on: n === page }" @click="go(n)">{{ n }}</button>
    <button class="pb-arrow" :disabled="page >= totalPages" @click="go(page + 1)" aria-label="下一页">
      <Icon name="arrow" />
    </button>
    <span class="pb-meta">共 {{ total }} 条</span>
  </nav>
  <nav class="pagebar pb-empty" v-else><span class="pb-meta"></span></nav>
</template>

<style scoped>
.pagebar { display: flex; align-items: center; gap: 6px; margin: 24px 0 8px; flex-wrap: wrap; }
.pb-arrow { display: grid; place-items: center; width: 32px; height: 32px;
  border-radius: 999px; border: 1px solid var(--line); background: var(--surface);
  color: var(--ink-2); cursor: pointer; }
.pb-arrow:disabled { opacity: .35; cursor: default; }
.pb-num { min-width: 32px; height: 32px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--line); background: transparent; color: var(--ink-2);
  font: inherit; font-size: 13px; cursor: pointer; }
.pb-num.on { border-color: var(--polaris); color: var(--polaris); font-weight: 700;
  background: rgba(255, 210, 125, .12); }
.pb-meta { margin-left: auto; font-size: 12.5px; color: var(--ink-3); }
</style>
