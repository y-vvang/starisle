<script setup>
import { reactive, ref, watch } from 'vue';
import { store, closeJoin, register, login } from '../store';
import Icon from '../../components/Icon.vue';

const regForm = reactive({ username: '', password: '', display_name: '', email: '', repo_url: '', apply_note: '' });
const loginForm = reactive({ username: '', password: '' });
const busy = ref(false);
const done = ref(false);       // 注册成功态
const doneNote = ref('');      // 服务端返回的原话
const errMsg = ref('');        // 真正的错误(密码错/账号被停用等)
const infoMsg = ref('');       // 平静的提示(审核中),不是错误

function setMode(m) {
  errMsg.value = ''; infoMsg.value = '';
  store.authMode = m;
}

// 弹窗每次重新打开时清掉上一轮遗留的提示,不然切换到另一模式还挂着旧错误。
watch(() => store.joinOpen, open => { if (open) { errMsg.value = ''; infoMsg.value = ''; } });

function onUsernameInput(f, e) { f.username = e.target.value.toLowerCase(); }

async function submitRegister() {
  errMsg.value = ''; infoMsg.value = '';
  busy.value = true;
  const r = await register({ ...regForm });
  busy.value = false;
  if (!r || r.error) { errMsg.value = (r && r.error) || '提交失败,请稍后再试'; return; }
  doneNote.value = r.note || '申请已提交,站长审核通过后即可登录。';
  done.value = true;
}

async function submitLogin() {
  errMsg.value = ''; infoMsg.value = '';
  busy.value = true;
  const r = await login(loginForm.username.trim().toLowerCase(), loginForm.password);
  busy.value = false;
  if (r && r.ok) { reset(); return; }
  const msg = (r && r.error) || '登录失败,请稍后再试';
  // 待审核不是错误,是产品正常在跑 —— 平静地告诉用户,而不是甩一个红色报错。
  if (msg.includes('审核中')) infoMsg.value = msg;
  else errMsg.value = msg;
}

function reset() {
  done.value = false; errMsg.value = ''; infoMsg.value = '';
  Object.keys(regForm).forEach(k => regForm[k] = '');
  Object.keys(loginForm).forEach(k => loginForm[k] = '');
  closeJoin();
}
</script>

<template>
  <Teleport to="body">
    <div class="join-mask" :class="{ open: store.joinOpen }" @click="closeJoin"></div>
    <div class="join-modal" :class="{ open: store.joinOpen }">
      <button class="close-x" @click="closeJoin" aria-label="关闭"><Icon name="x" /></button>

      <template v-if="!done">
        <div class="mode-tabs">
          <button class="mode-tab" :class="{ on: store.authMode === 'register' }" @click="setMode('register')">申请加入</button>
          <button class="mode-tab" :class="{ on: store.authMode === 'login' }" @click="setMode('login')">登录</button>
        </div>

        <!-- 注册 -->
        <template v-if="store.authMode === 'register'">
          <div class="jm-head">
            <div class="jm-kick">加入星屿 · 邀请制 + 审核制</div>
            <h3>申请加入这片银河</h3>
            <p>只看你真的在做什么。填完由站长人工审核,通过后即可用这个账号登录。</p>
          </div>
          <div class="jm-grid">
            <div class="form-field">
              <label>用户名(登录用)</label>
              <input :value="regForm.username" @input="onUsernameInput(regForm, $event)" maxlength="32" placeholder="moss-kid" autocomplete="username" />
              <div class="field-hint">只能用小写字母、数字、下划线、连字符。</div>
            </div>
            <div class="form-field">
              <label>密码</label>
              <input v-model="regForm.password" type="password" maxlength="72" placeholder="至少 8 位" autocomplete="new-password" />
            </div>
            <div class="form-field">
              <label>显示名</label>
              <input v-model="regForm.display_name" maxlength="32" placeholder="观澜 / moss_kid" />
              <div class="field-hint">用户名用于登录和主页地址,不可更改;显示名是别人看到的名字,随时可改。</div>
            </div>
            <div class="form-field">
              <label>邮箱</label>
              <input v-model="regForm.email" maxlength="120" placeholder="you@example.com" autocomplete="email" />
            </div>
          </div>
          <div class="form-field"><label>Gitee 主页(选填)</label><input v-model="regForm.repo_url" maxlength="200" placeholder="gitee.com/你的用户名" /></div>
          <div class="form-field"><label>申请说明(≥10 字)</label><textarea v-model="regForm.apply_note" maxlength="500" placeholder="你想在星屿做什么?为什么是现在?"></textarea></div>
          <p class="jm-err" v-if="errMsg">{{ errMsg }}</p>
          <button class="btn primary wide" :disabled="busy" @click="submitRegister"><Icon name="star" /> {{ busy ? '提交中…' : '提交申请' }}</button>
        </template>

        <!-- 登录 -->
        <template v-else>
          <div class="jm-head">
            <div class="jm-kick">欢迎回来</div>
            <h3>登录星屿</h3>
            <p>用申请时填的用户名和密码登录。还没有账号?切到「申请加入」。</p>
          </div>
          <div class="form-field">
            <label>用户名</label>
            <!-- 登录框不做小写归一化:username 列是 citext(大小写不敏感),后端 login 又会
                 .toLowerCase() 一次,前端再改一遍换不来任何东西,只会让人以为键盘坏了。
                 注册框那边保留归一化——那里要当场显示真正会存进库的形式,且旁边有规则提示。 -->
            <input v-model="loginForm.username" maxlength="32" placeholder="用户名" autocomplete="username" @keyup.enter="submitLogin" />
          </div>
          <div class="form-field">
            <label>密码</label>
            <input v-model="loginForm.password" type="password" maxlength="72" placeholder="密码" autocomplete="current-password" @keyup.enter="submitLogin" />
          </div>
          <p class="jm-info" v-if="infoMsg"><Icon name="clock" /> {{ infoMsg }}</p>
          <p class="jm-err" v-if="errMsg">{{ errMsg }}</p>
          <button class="btn primary wide" :disabled="busy" @click="submitLogin"><Icon name="planet" /> {{ busy ? '登录中…' : '登录' }}</button>
        </template>
      </template>

      <div class="jm-done" v-else>
        <div class="done-glyph"><Icon name="check" class="lg" /></div>
        <h3>申请已提交 ✦</h3>
        <p>{{ doneNote }}</p>
        <button class="btn primary" @click="reset">好的</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.join-mask { position: fixed; inset: 0; background: rgba(2, 4, 12, .66); backdrop-filter: blur(4px); z-index: 300; opacity: 0; pointer-events: none; transition: .3s; }
.join-mask.open { opacity: 1; pointer-events: auto; }
.join-modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -46%) scale(.97); z-index: 301;
  width: min(640px, calc(100vw - 32px)); max-height: 90vh; overflow-y: auto; padding: 34px 34px 30px;
  background: linear-gradient(180deg, var(--surface), var(--bg-2)); border: 1px solid var(--line-strong); border-radius: 22px;
  box-shadow: 0 40px 100px rgba(0, 0, 0, .6); opacity: 0; pointer-events: none; transition: .32s var(--ease-out, ease); }
.join-modal.open { opacity: 1; transform: translate(-50%, -50%); pointer-events: auto; }
.close-x { position: absolute; top: 18px; right: 18px; width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--line); background: var(--glass); color: var(--ink-2); cursor: pointer; display: grid; place-items: center; }
.close-x:hover { color: var(--ink); border-color: var(--line-strong); }
.mode-tabs { display: flex; gap: 8px; margin-bottom: 22px; }
.mode-tab { padding: 7px 16px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--ink-3); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s; }
.mode-tab:hover { color: var(--ink-2); border-color: var(--line-strong); }
.mode-tab.on { background: rgba(255, 210, 125, .14); border-color: var(--polaris); color: var(--polaris); }
.jm-head { border-bottom: 1px solid var(--line); padding-bottom: 18px; margin-bottom: 20px; }
.jm-kick { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--polaris); margin-bottom: 8px; }
.jm-head h3 { font-size: 24px; letter-spacing: -.02em; }
.jm-head p { font-size: 13px; color: var(--ink-2); line-height: 1.65; margin-top: 10px; }
.jm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
.field-hint { font-size: 11.5px; color: var(--ink-3); line-height: 1.5; margin-top: 6px; }
.jm-err { font-size: 13px; color: var(--bad); background: rgba(248, 113, 113, .08); border: 1px solid rgba(248, 113, 113, .28); border-radius: 10px; padding: 10px 14px; margin: 4px 0 14px; }
.jm-info { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--warn); background: rgba(251, 191, 36, .1); border: 1px solid rgba(251, 191, 36, .3); border-radius: 10px; padding: 10px 14px; margin: 4px 0 14px; }
.btn.wide { width: 100%; justify-content: center; margin-top: 6px; }
.jm-done { text-align: center; padding: 20px 0; }
.done-glyph { width: 64px; height: 64px; margin: 0 auto 18px; border-radius: 50%; display: grid; place-items: center;
  color: var(--ok); background: rgba(74, 222, 128, .12); border: 1px solid rgba(74, 222, 128, .3); }
.jm-done h3 { font-size: 22px; }
.jm-done p { font-size: 13.5px; color: var(--ink-2); line-height: 1.65; max-width: 440px; margin: 12px auto 22px; }
@media (max-width: 560px) { .jm-grid { grid-template-columns: 1fr; } .join-modal { padding: 26px 20px; } }
</style>
