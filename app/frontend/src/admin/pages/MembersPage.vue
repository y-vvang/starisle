<script setup lang="ts">
import { inject, onMounted, ref } from 'vue';
import type { Ref } from 'vue';
import { api, post, toast } from '../../lib/api';
import Icon from '../../components/Icon.vue';
import PaginationBar from '../../components/PaginationBar.vue';

const me = inject<Ref<any>>('me', ref<any>(null));
const members = ref<any[]>([]);
const busy = ref<string | number>('');
const page = ref(1);
const pagination = ref({ page: 1, per_page: 20, total: 0, total_pages: 1 });

async function load(p = page.value) {
  page.value = p;
  const r = await api('/members' + (p > 1 ? `?page=${p}` : ''));
  members.value = (r && r.members) || [];
  pagination.value = (r && r.pagination) || pagination.value;
}
onMounted(() => load());

// 与 UserReviewPage 同一条钳制:当前页删空退回 total_pages
async function loadClamped() {
  await load();
  const tp = pagination.value.total_pages;
  if (page.value > tp) await load(Math.max(1, tp));
}

// id 是 number:app/db/pool.ts 给 bigint(OID 20)注册了 Number 类型解析器,
// 每条从 pg 出来的 id 天生就是数字。这里的 me.id === m.id 与 busy === m.id
// 两边都来自同一批接口响应,同源同类型,直接 === 即可,不要再手工转型。
async function suspend(m: any) {
  if (!confirm(`确认停用「${m.display_name || m.username}」?停用后会立刻踢下线,且不能自行恢复。`)) return;
  busy.value = m.id;
  const r = await post(`/admin/users/${m.id}/suspend`, {});
  busy.value = '';
  if (!r || r.error) return toast((r && r.error) || '操作失败');
  toast(`已停用「${r.username}」`);
  await loadClamped();
}

function pickPage(p: number) { load(p); }
</script>

<template>
  <section class="admin-page active">
    <h2>成员管理 · Members <span style="font-size:13px;color:var(--ink-3);font-weight:400">已过审的全部成员</span></h2>
    <p class="page-sub">停用会立即结束该账号的所有登录会话,且账号无法自行恢复,请谨慎操作。</p>

    <div class="empty" v-if="!members.length"><Icon name="check" style="color:var(--ok)" /> 暂无已过审成员。</div>

    <div class="card mem" v-for="m in members" :key="m.id">
      <div class="mem-glyph"><Icon name="user" /></div>
      <div class="mem-body">
        <h3>{{ m.display_name }} <span class="real" v-if="m.display_name !== m.username">· @{{ m.username }}</span></h3>
        <div class="mem-sub">{{ m.bio || '（未填简介）' }}<span class="contact" v-if="m.repo_url"> · <Icon name="link" style="width:.8em" /> {{ m.repo_url }}</span></div>
      </div>
      <div class="mem-acts">
        <span class="badge" v-if="me && me.id === m.id">本人</span>
        <button class="btn small danger" v-else :disabled="busy === m.id" @click="suspend(m)"><Icon name="x" /> 停用</button>
      </div>
    </div>

    <PaginationBar :page="pagination.page" :per-page="pagination.per_page"
                   :total="pagination.total" @change="pickPage" />
  </section>
</template>

<style scoped>
.empty { font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 8px; }
.mem { margin-bottom: 12px; display: flex; align-items: center; gap: 14px; }
.mem-glyph { width: 42px; height: 42px; flex: none; border-radius: 12px; display: grid; place-items: center; color: var(--astral); background: rgba(125, 180, 255, .08); border: 1px solid rgba(125, 180, 255, .22); }
.mem-body { min-width: 0; flex: 1; }
.mem-body h3 { font-size: 15.5px; display: flex; align-items: center; gap: 8px; }
.mem-sub { font-size: 12.5px; color: var(--ink-3); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-sub .contact { color: var(--astral); }
.real { font-size: 13px; color: var(--ink-2); font-weight: 500; }
.mem-acts { flex: none; }
</style>
