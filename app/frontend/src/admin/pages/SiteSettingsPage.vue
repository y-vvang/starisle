<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, patch, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

// 首页配置页(推荐位机器)随首页那 12 个已下线模块一并拆掉,这里只留一个真开关:
// GET /api/settings/public 读、PATCH /api/admin/settings 写。
const registrationOpen = ref(true);
const loaded = ref(false);
const busy = ref(false);

onMounted(async () => {
  const r = await api('/settings/public');
  registrationOpen.value = !!(r && r.registration_open);
  loaded.value = true;
});

async function toggle() {
  const next = !registrationOpen.value;
  busy.value = true;
  const r = await patch('/admin/settings', { registration_open: next });
  busy.value = false;
  if (!r || r.error) { toast((r && r.error) || '保存失败'); return; }
  registrationOpen.value = !!r.registration_open;
  toast(registrationOpen.value ? '已开放注册' : '已关闭注册');
}
</script>

<template>
  <div class="admin-page active">
    <div class="page-head">
      <h1>站点设置 <span class="dim">Settings</span></h1>
      <p>控制主站的注册入口是否对外开放。</p>
    </div>

    <div class="card switch-cfg" v-if="loaded">
      <div class="switch-row">
        <div class="switch-text">
          <h3><Icon name="gate" /> 开放注册</h3>
          <p>开启后,主站显示注册入口,任何人都能提交入会申请(仍需站长审核通过才能登录)。关闭后注册入口从主站隐藏。</p>
        </div>
        <button type="button" class="switch" :class="{ on: registrationOpen }" :disabled="busy"
          role="switch" :aria-checked="registrationOpen" @click="toggle">
          <span class="knob"></span>
        </button>
      </div>
      <div class="switch-state">当前:<b :class="registrationOpen ? 'on' : 'off'">{{ registrationOpen ? '开放注册' : '已关闭注册' }}</b></div>
    </div>
  </div>
</template>

<style scoped>
.switch-cfg { padding: 20px 22px; }
.switch-row { display: flex; align-items: flex-start; gap: 20px; }
.switch-text { flex: 1; min-width: 0; }
.switch-text h3 { font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 7px; }
.switch-text p { font-size: 13px; color: var(--ink-3); line-height: 1.65; margin: 0; }
.dim { color: var(--ink-3); font-size: 12px; font-weight: 400; }

.switch {
  flex: none; width: 46px; height: 26px; border-radius: 999px; border: 1px solid var(--line-strong);
  background: var(--bg); padding: 2px; cursor: pointer; transition: background .18s, border-color .18s;
}
.switch:disabled { cursor: default; opacity: .6; }
.switch .knob {
  display: block; width: 20px; height: 20px; border-radius: 50%; background: var(--surface);
  box-shadow: 0 1px 3px rgba(20,30,60,.25); transition: transform .18s;
}
.switch.on { background: var(--ok); border-color: var(--ok); }
.switch.on .knob { transform: translateX(20px); }

.switch-state { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--ink-3); }
.switch-state b.on { color: var(--ok); }
.switch-state b.off { color: var(--bad); }
</style>
