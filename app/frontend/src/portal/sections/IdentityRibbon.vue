<script setup>
import { computed, ref, watch } from 'vue';
import { store, logout, openLogin } from '../store';
import { api, post, ago, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

// 演示身份条(ROLE 映射 / 快捷入口)已随前端重写移除;身份展示现在接的是
// 真实登录用户(HttpOnly cookie 会话):已登录显示显示名 + 退出登录,
// 未登录显示一个去登录/申请加入的入口。通知铃铛与面板原样保留。
const notifs = ref([]);
const notifOpen = ref(false);
const unread = computed(() => notifs.value.filter(n => !n.read_at).length);
const NT_ICON = { account: 'check', project: 'planet' };
async function loadNotifs() {
  if (!store.user) { notifs.value = []; return; }
  const r = await api('/notifications');
  notifs.value = (r && r.notifications) || [];
}
watch(() => store.user, loadNotifs, { immediate: true });
async function openNotif() {
  notifOpen.value = !notifOpen.value;
  if (notifOpen.value && unread.value) { await post('/notifications/read', {}); notifs.value.forEach(n => { n.read_at = n.read_at || new Date().toISOString(); }); }
}

async function doLogout() {
  notifOpen.value = false;
  await logout();
  toast('已退出登录');
}
</script>

<template>
  <div class="ribbon">
    <div class="rb-inner">
      <div class="rb-id" v-if="store.user">
        <span class="rb-name"><Icon name="user" /> {{ store.user.display_name || store.user.username }}</span>
        <button class="rb-logout" @click="doLogout"><Icon name="back" /> 退出登录</button>
      </div>
      <a class="rb-entry" href="#" v-else @click.prevent="openLogin"><Icon name="user" /> 登录 / 申请加入</a>

      <div class="rb-bell-wrap" v-if="store.user">
        <button class="rb-bell" :class="{ has: unread }" @click="openNotif" aria-label="通知">
          <Icon name="pulse" /><span class="bell-badge" v-if="unread">{{ unread }}</span>
        </button>
        <div class="notif-panel" :class="{ open: notifOpen }">
          <div class="np-head">通知与消息</div>
          <div class="np-empty" v-if="!notifs.length">还没有通知。</div>
          <div class="np-item" v-for="n in notifs" :key="n.id" :class="{ unread: !n.read_at }">
            <span class="np-ic" :class="n.kind"><Icon :name="NT_ICON[n.kind] || 'star'" /></span>
            <div class="np-body">
              <div class="np-title">{{ n.title }}<span class="np-when">{{ ago(n.created_at) }}</span></div>
              <div class="np-text">{{ n.body }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ribbon { position: fixed; top: 54px; right: 0; z-index: 85; pointer-events: none; }
.rb-inner { max-width: 1180px; margin: 0 auto; padding: 9px 28px; display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
.rb-id { display: flex; align-items: center; gap: 8px; pointer-events: auto; }
.rb-name { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line-strong);
  background: var(--glass); backdrop-filter: blur(24px) saturate(180%); color: var(--ink); font-size: 13px; font-weight: 600; }
.rb-name .icon { color: var(--polaris); }
.rb-logout { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line-strong);
  background: var(--glass); backdrop-filter: blur(24px) saturate(180%); color: var(--ink-3); font: inherit; font-size: 12.5px; cursor: pointer; transition: all .2s; }
.rb-logout:hover { color: var(--bad); border-color: rgba(248, 113, 113, .4); }
.rb-entry { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line-strong);
  background: var(--glass); backdrop-filter: blur(24px) saturate(180%); color: var(--ink-2); font-size: 13px; font-weight: 600; text-decoration: none; transition: all .2s; }
.rb-entry:hover { color: var(--ink); border-color: var(--astral); }
.rb-bell-wrap { position: relative; pointer-events: auto; }
.rb-bell { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px;
  border-radius: 999px; border: 1px solid var(--line-strong); background: var(--glass); backdrop-filter: blur(24px) saturate(180%); color: var(--ink-2); cursor: pointer; transition: all .2s; }
.rb-bell:hover { color: var(--ink); border-color: var(--astral); }
.rb-bell.has { color: var(--astral); border-color: rgba(125, 180, 255, .45); }
.bell-badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
  background: var(--bad); color: #fff; font-size: 10px; font-weight: 700; display: grid; place-items: center; }
.notif-panel { position: absolute; top: calc(100% + 10px); right: 0; width: min(360px, calc(100vw - 32px)); z-index: 20;
  background: var(--glass); backdrop-filter: blur(24px) saturate(180%); border: 1px solid var(--line-strong); border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, .5); opacity: 0; transform: translateY(-8px) scale(.98); pointer-events: none; transition: .22s var(--ease-out, ease); max-height: 70vh; overflow-y: auto; }
.notif-panel.open { opacity: 1; transform: none; pointer-events: auto; }
.np-head { font-size: 13px; font-weight: 700; padding: 13px 16px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--glass); }
.np-empty { padding: 24px 16px; font-size: 13px; color: var(--ink-3); text-align: center; }
.np-item { display: flex; gap: 11px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.np-item.unread { background: rgba(125, 180, 255, .05); }
.np-ic { flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 9px; background: rgba(125, 180, 255, .1); color: var(--astral); }
.np-ic.resource { color: var(--glow-climate); background: rgba(110, 231, 160, .1); }
.np-ic.scout { color: var(--glow-agent); background: rgba(167, 139, 250, .1); }
.np-ic.risk { color: var(--warn); background: rgba(251, 191, 36, .1); }
.np-body { flex: 1; min-width: 0; }
.np-title { font-size: 13px; font-weight: 600; color: var(--ink); display: flex; justify-content: space-between; gap: 8px; }
.np-when { color: var(--ink-3); font-weight: 400; font-size: 11px; white-space: nowrap; }
.np-text { font-size: 12px; color: var(--ink-2); line-height: 1.5; margin-top: 3px; }
@media (max-width: 640px) { .ribbon { top: 50px; } .rb-inner { padding: 8px 16px; } }
</style>
