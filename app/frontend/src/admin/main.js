import { createApp } from 'vue';
import '../styles/global.css';
import AdminApp from './AdminApp.vue';

// 后台鉴权已随 P0 安全止血改为 HttpOnly cookie 会话(见 lib/api.js),
// 不再有前端持有的口令字符串可恢复。AdminApp 目前用 store.user.role==='admin'
// 判断是否放行;真正把控制台登录流程接到 /api/auth/login 是 Task 18 的范围。

createApp(AdminApp).mount('#app');
