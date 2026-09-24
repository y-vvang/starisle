<script setup lang="ts">
// 统一 SVG 图标系统 —— 全站唯一的视觉符号来源,替代所有 emoji。
// stroke 1.7 / currentColor / 24 viewBox,与深空视觉同源。
defineProps<{
  name: string;
  size?: string; // '' | 'lg' | 'xl'
}>();

const FILL = new Set<string>(['star', 'dot']);

const PATHS: Record<string, string> = {
  // 品牌四角星(fill)
  star: '<path d="M12 2.2 14.3 9.7 21.8 12 14.3 14.3 12 21.8 9.7 14.3 2.2 12 9.7 9.7Z"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
  // 行星:球体 + 轨道环
  planet: '<circle cx="12" cy="12" r="6.2"/><path d="M3.4 14.8c-1.2-1-1.6-2-1-2.8 1.1-1.5 6-1.4 11 .3 5 1.6 8.5 4.1 7.4 5.6-.5.8-2 .9-4 .5"/>',
  // 守门(拱门)
  gate: '<path d="M4 21V10a8 8 0 0 1 16 0v11"/><path d="M9 21v-7a3 3 0 0 1 6 0v7"/><path d="M2.5 21h19"/>',
  // 搬运/安全(盾)
  shield: '<path d="M12 2.8 19 5.6v5.2c0 4.6-2.9 7.9-7 9.9-4.1-2-7-5.3-7-9.9V5.6Z"/><path d="m9 11.6 2.1 2.1L15 9.6"/>',
  // 决议(卷轴)
  scroll: '<path d="M7 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2h2"/><path d="M10 9h6M10 13h6M10 17h3.5"/>',
  // 直播(闪电)
  bolt: '<path d="M13 2 4.5 13.5h6L10 22l8.7-11.5h-6Z"/>',
  // 事件脉冲
  pulse: '<path d="M2.5 12h4l2.2-6 4.4 12 2.2-6h6.2"/>',
  // 时钟
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.4 2.2"/>',
  // 仪表盘(四宫格)
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  // 勾/叉
  check: '<path d="m4.5 12.5 5 5L19.5 7"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  // 箭头
  arrow: '<path d="M4 12h15M13 5.5 19.5 12 13 18.5"/>',
  back: '<path d="M20 12H5M11 5.5 4.5 12l6.5 6.5"/>',
  // 旗(缺口)
  flag: '<path d="M5.5 21V4"/><path d="M5.5 4.8c2.2-1.4 4.4-1.4 6.6 0s4.4 1.4 6.6 0v8.4c-2.2 1.4-4.4 1.4-6.6 0s-4.4-1.4-6.6 0"/>',
  // 链接(仓库)
  link: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.8 4.7a4 4 0 0 1 5.7 5.7L16.6 12.2"/><path d="M13 17.5 11.2 19.3a4 4 0 0 1-5.7-5.7L7.4 11.8"/>',
  // 重置
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
  // 成员(星形人)
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.2c1.2-3.8 4-5.7 7.5-5.7s6.3 1.9 7.5 5.7"/>',
  // 播放(演示)
  play: '<path d="M7.5 4.8 18.5 12 7.5 19.2Z"/>',
  // 发送(定向推荐)
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14 21l-3.5-7.5L3 10Z"/>',
  // 数据库
  db: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13"/><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>',
  // 成员管理(两人)
  team: '<circle cx="8.3" cy="8" r="3.1"/><path d="M2.6 19.2c1-3.3 2.9-5 5.7-5s4.7 1.7 5.7 5"/><circle cx="17" cy="8.6" r="2.5"/><path d="M15.3 14.3c2.3.2 3.9 1.7 4.7 4.5"/>',
  // 站点设置(齿轮)
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.6v2.5M12 17.9v2.5M20.4 12h-2.5M6.1 12H3.6M17.7 6.3l-1.8 1.8M8.1 15.9l-1.8 1.8M17.7 17.7l-1.8-1.8M8.1 8.1 6.3 6.3"/>',
};
</script>

<template>
  <svg class="icon" :class="size" viewBox="0 0 24 24"
    :fill="FILL.has(name) ? 'currentColor' : 'none'"
    :stroke="FILL.has(name) ? 'none' : 'currentColor'"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    v-html="PATHS[name] || ''" aria-hidden="true" />
</template>
