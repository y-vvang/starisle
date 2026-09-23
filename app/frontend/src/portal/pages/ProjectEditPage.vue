<script setup>
// #/project/:slug/edit —— 项目属主(或站长)编辑自己的项目。
//
// 后端 PATCH /api/projects/:slug 一直支持属主修改(含未过审项目),此前只是前端
// 没有任何入口。这一页把入口补上,并接通 003 迁移新增的三块内容字段。
//
// 权限判断和详情页用同一条线:按 username 比对 owner —— GET /api/projects/:slug 的
// card() 不返回 owner 的数字 id,只有 username;username 不可更改,拿它比是稳的。
// 真正的权限在服务端,这里只是不摆出一个注定失败的表单。
import { ref, computed, watch } from 'vue';
import { store, actUpdateProject } from '../store';
import { router, go } from '../../lib/router';
import { api, toast } from '../../lib/api';
import { linesToList, listToLines, csvToList, listToCsv, linesToGaps, gapsToLines } from '../../lib/content';
import Icon from '../../components/Icon.vue';

const loading = ref(true);
const denied = ref(false);
const busy = ref(false);
const err = ref('');
const slug = computed(() => router.param);

const f = ref({
  name: '', tagline: '', description: '', repo_url: '', domain_id: '',
  work: '', stackText: '', milestonesText: '', gapsText: '',
});

const isOwnerOrAdmin = p =>
  !!(store.user && p && p.owner &&
     (store.user.username === p.owner.username || store.user.role === 'admin'));

async function load() {
  if (!slug.value) return;
  loading.value = true; denied.value = false; err.value = '';
  const r = await api('/projects/' + encodeURIComponent(slug.value));
  loading.value = false;
  if (!r || r.error || !r.project) {
    denied.value = true;
    return;
  }
  if (!isOwnerOrAdmin(r.project)) {
    denied.value = true;
    toast('只有发起人能编辑这个项目');
    return;
  }
  const p = r.project;
  f.value = {
    name: p.name || '', tagline: p.tagline || '', description: p.description || '',
    repo_url: p.repo_url || '', domain_id: p.domain_id || '',
    work: p.work || '',
    stackText: listToCsv(p.stack),
    milestonesText: listToLines(p.milestones),
    gapsText: gapsToLines(p.gaps),
  };
}

// store.user 要等 boot() 拉完 /auth/me 才有值,直接在 setup 里判权限会误判成未登录。
watch([slug, () => store.user], load, { immediate: true });

async function save() {
  err.value = '';
  if (!f.value.name.trim()) { err.value = '请填写项目名'; return; }
  if (f.value.description.trim().length < 20) { err.value = '简介至少 20 字'; return; }
  busy.value = true;
  const r = await actUpdateProject(slug.value, {
    name: f.value.name, tagline: f.value.tagline, description: f.value.description,
    repo_url: f.value.repo_url, domain_id: f.value.domain_id || undefined,
    work: f.value.work,
    stack: csvToList(f.value.stackText),
    milestones: linesToList(f.value.milestonesText),
    gaps: linesToGaps(f.value.gapsText),
  });
  busy.value = false;
  if (!r || r.error) { err.value = (r && r.error) || '保存失败,请稍后再试'; return; }
  toast('已保存 ✦');
  go('project/' + encodeURIComponent(slug.value));
}

const back = () => go('project/' + encodeURIComponent(slug.value));
</script>

<template>
  <div class="page pe-page">
    <a class="pd-back" @click="back"><Icon name="back" /> 返回项目</a>

    <p v-if="loading" class="dim">载入中…</p>

    <div v-else-if="denied" class="pe-denied">
      <h2>打不开这个编辑页</h2>
      <p class="dim">项目不存在,或者你不是它的发起人。</p>
      <button class="btn ghost" @click="go('projects')"><Icon name="back" /> 去项目列表</button>
    </div>

    <template v-else>
      <div class="pe-head">
        <div class="jm-kick">编辑项目</div>
        <h2>{{ f.name || '未命名项目' }}</h2>
        <p class="dim">改完保存即可。已上线的项目改动会立刻生效,不需要重新审核。</p>
      </div>

      <section class="card pe-card">
        <h3>基本信息</h3>
        <div class="form-field"><label>项目名</label>
          <input v-model="f.name" maxlength="60" placeholder="一眼能记住的名字" /></div>
        <div class="form-field"><label>一句话介绍</label>
          <input v-model="f.tagline" maxlength="120" placeholder="它解决谁的什么问题" /></div>
        <div class="form-field"><label>详细介绍(≥20 字)</label>
          <textarea v-model="f.description" maxlength="4000" rows="4"
                    placeholder="在做什么、做到哪一步、和别人有什么不一样"></textarea></div>
        <div class="form-field"><label>代码仓库(选填)</label>
          <input v-model="f.repo_url" maxlength="200" placeholder="gitee.com/你/仓库" /></div>
        <div class="form-field"><label>领域</label>
          <select v-model="f.domain_id">
            <option value="">不指定</option>
            <option v-for="d in store.domains" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select></div>
      </section>

      <section class="card pe-card">
        <h3>详情页的三块内容</h3>
        <p class="dim pe-hint">这三块就是项目详情页上 02 / 03 / 04 那三张卡。留空的话那张卡会显示占位文案。</p>

        <div class="form-field"><label>02 主要工作</label>
          <textarea v-model="f.work" maxlength="4000" rows="3"
                    placeholder="这段时间具体在做的事,一段话就行"></textarea></div>

        <div class="form-field"><label>技术栈</label>
          <input v-model="f.stackText" placeholder="Vue 3, Node, llama.cpp" />
          <div class="field-hint">逗号分隔,会显示成详情页上的小标签。</div></div>

        <div class="form-field"><label>03 阶段性成果</label>
          <textarea v-model="f.milestonesText" rows="4"
                    placeholder="跑通离线推理&#10;接入错题 OCR&#10;在两所中学试用"></textarea>
          <div class="field-hint">一行一条,最多 20 条,单条 200 字以内。</div></div>

        <div class="form-field"><label>04 当前需求</label>
          <textarea v-model="f.gapsText" rows="3"
                    placeholder="前端 | 会 Vue 优先&#10;Android"></textarea>
          <div class="field-hint">一行一条。写成「缺什么 | 补充说明」,竖线和说明可以省略。</div></div>
      </section>

      <p class="jm-err" v-if="err">{{ err }}</p>
      <div class="pe-actions">
        <button class="btn primary" :disabled="busy" @click="save">
          <Icon name="check" /> {{ busy ? '保存中…' : '保存' }}
        </button>
        <button class="btn ghost" :disabled="busy" @click="back">取消</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* .page 自己是全宽的,这里收窄成单栏表单宽度就必须自己居中,
   否则整页会贴到浏览器最左边。 */
.pe-page { max-width: 760px; margin: 0 auto; padding: 96px 28px 80px; }
/* .pd-back 是 ProjectDetailPage 的 scoped 类,这里要自己带一份。 */
.pd-back { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3); font-size: 13.5px; cursor: pointer; margin-bottom: 20px; }
.pd-back:hover { color: var(--astral); }
.pe-head { margin: 18px 0 22px; }
.pe-head h2 { font-size: 30px; font-weight: 800; margin: 6px 0 8px; }
.pe-card { margin-bottom: 18px; }
.pe-card h3 { margin-bottom: 14px; }
.pe-hint { margin-top: -6px; margin-bottom: 16px; font-size: 13px; }
.pe-actions { display: flex; gap: 12px; margin: 4px 0 40px; }
.pe-denied { padding: 60px 0; text-align: center; }
.pe-denied h2 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
.pe-denied p { margin-bottom: 20px; }
</style>
