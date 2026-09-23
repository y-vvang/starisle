/* 会话由 HttpOnly cookie 承载(见后端 P0 鉴权改造),前端不再持有任何令牌:
   每个请求都带 credentials: 'same-origin',浏览器自动附带 cookie。
   旧的单一后台口令(Bearer)机制 —— setAdminToken / getAdminToken / onAuthLost
   与 401 时清令牌的逻辑 —— 随之整体删除。 */
export const api = (p, opt) => {
  const o = { credentials: 'same-origin', ...(opt || {}) };
  // 仍然 resolve 成对象:现存调用点本来就容忍 {error} 形状,不必逐个改。
  // 额外做一件事:服务端会话失效(401)时广播一个全局事件,不改变 resolve
  // 出来的对象形状——现有调用点不受影响,只有想监听"会话掉了"的地方
  // (目前是后台控制台)才去 addEventListener。
  return fetch('/api' + p, o).then(r => {
    if (r.status === 401) window.dispatchEvent(new CustomEvent('starisle:unauthorized'));
    return r.json().catch(() => ({ error: 'bad response' }));
  });
};
export const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
export const patch = (p, body) => api(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
export const del = p => api(p, { method: 'DELETE' });

export const ago = ts => {
  const h = (Date.now() - new Date(ts).getTime()) / 3600000;
  if (h < 1) return '刚刚';
  if (h < 24) return Math.round(h) + ' 小时前';
  return Math.round(h / 24) + ' 天前';
};

export const tzLabel = tz => 'UTC' + (tz >= 0 ? '+' : '') + tz;

export const STAGE = { stardust: '星尘', nebula: '星云', supernova: '超新星' };
export const STATUS = { thriving: ['存活 90 天+', 'supernova'], active: ['活跃', 'nebula'], incubating: ['孵化中', 'stardust'], approved: ['进行中', 'nebula'], pending: ['待审核', 'stardust'] };

/* 全局 toast(单例) */
let toastEl = null, toastTimer = null;
export function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* 光标追随辉光 */
export function initCursorLight() {
  let pending = null;
  document.addEventListener('mousemove', e => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const t = e.target.closest && e.target.closest('.card, .stile, .chart-card, .post, .match-card, .gov-card');
      if (!t) return;
      const r = t.getBoundingClientRect();
      t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      t.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  }, { passive: true });
}

/* 数字滚动 */
export function countUp(el, target, dur = 1300) {
  const n = +target;
  if (!el || !isFinite(n)) return;
  const t0 = performance.now();
  const tick = t => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(n * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* v-reveal 指令:滚动显现 */
export const vReveal = {
  mounted(el, binding) {
    el.classList.add('reveal-up');
    el.style.transitionDelay = ((binding.value || 0) % 6) * 60 + 'ms';
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { threshold: 0.12 });
    io.observe(el);
  },
};
