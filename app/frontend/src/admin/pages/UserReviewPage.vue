<script setup>
import { onMounted, ref } from 'vue';
import { api, post, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';

const pending = ref([]);
const busy = ref('');
async function load() {
  const r = await api('/admin/users/pending');
  pending.value = (r && r.users) || [];
}
onMounted(load);

// user.id 是 number(app/db/pool.js 给 bigint/OID 20 注册了 Number 解析器);
// busy 与 u.id 同源,直接 === 比较,不需要转型。
async function review(u, decision) {
  busy.value = u.id;
  const r = await post(`/admin/users/${u.id}/review`, { decision });
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '操作失败');
  toast(decision === 'approve' ? `已通过「${r.username}」的加入申请` : `已婉拒「${r.username}」`);
  await load();
}
</script>

<template>
  <section class="admin-page active">
    <h2>待审用户 · Admission <span style="font-size:13px;color:var(--ink-3);font-weight:400">邀请制 + 审核制</span></h2>
    <p class="page-sub">逐份人工审核申请,通过后即可用账号密码登录。</p>

    <h3 class="sec-h"><Icon name="user" style="color:var(--warn)" /> 待审申请 <span class="cnt">{{ pending.length }}</span></h3>
    <div class="empty" v-if="!pending.length"><Icon name="check" style="color:var(--ok)" /> 暂无待审的加入申请。</div>

    <div class="card ua" v-for="u in pending" :key="u.id">
      <div class="ua-head">
        <div class="ua-glyph"><Icon name="user" /></div>
        <div>
          <h3>{{ u.display_name }} <span class="real" v-if="u.display_name !== u.username">· @{{ u.username }}</span> <span class="badge warn">待审核</span></h3>
          <div class="ua-sub">{{ u.email }}<span class="contact" v-if="u.repo_url"> · <Icon name="link" style="width:.8em" /> {{ u.repo_url }}</span></div>
        </div>
        <div class="ua-acts">
          <button class="btn small ok" :disabled="busy === u.id" @click="review(u, 'approve')"><Icon name="check" /> 通过</button>
          <button class="btn small ghost" :disabled="busy === u.id" @click="review(u, 'reject')"><Icon name="x" /> 拒绝</button>
        </div>
      </div>
      <div class="ua-note">"{{ u.apply_note }}"</div>
    </div>
  </section>
</template>

<style scoped>
.sec-h { font-size: 16px; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
.cnt { font-size: 12px; color: var(--warn); background: rgba(251, 191, 36, .14); padding: 1px 9px; border-radius: 999px; }
.empty { font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; }
.ua { margin-bottom: 14px; }
.ua-head { display: flex; align-items: flex-start; gap: 14px; }
.ua-glyph { width: 42px; height: 42px; flex: none; border-radius: 12px; display: grid; place-items: center; color: var(--polaris); background: rgba(255, 210, 125, .1); border: 1px solid rgba(255, 210, 125, .25); }
.ua-head h3 { font-size: 17px; display: flex; align-items: center; gap: 10px; }
.ua-sub { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; }
.ua-acts { margin-left: auto; display: flex; gap: 8px; flex: none; }
.ua-note { font-size: 13px; color: var(--ink-2); font-style: italic; padding-top: 12px; margin-top: 12px; border-top: 1px solid var(--line); }
.real { font-size: 13px; color: var(--ink-2); font-weight: 500; }
.ua-sub .contact { color: var(--astral); }
</style>
