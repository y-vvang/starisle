#!/usr/bin/env bash
# 星屿 Starisle · PostgreSQL 后端端到端演示
#
# 讲一个完整故事:建站长 -> 新人申请被拒登录 -> 站长审核 -> 新人登录发项目
# -> 匿名可见性变化 -> 重启进程验证数据没丢。全程只打 API,不依赖前端
# (前端还没跟新后端对接,详见 demo/DEMO-BACKEND.md)。
#
# 用法: bash demo/backend-demo.sh   (在 Git Bash 里跑;仓库根目录下执行也可以,
# 脚本自己会 cd 到仓库根)
#
# 关键约束(踩过坑,别改):
#   - 请求体里的中文一律先写文件,再用 curl --data-binary @file 发送。
#     直接把中文塞进 shell argv 传给 curl.exe/node.exe,在这台机器上会被
#     MSYS 的 argv 转换悄悄吃掉(实测:argv 里的中文变成 undefined,不是乱码,
#     是参数直接消失)。环境变量不受影响,可以放中文。
#   - 用独立数据库 starisle_demo,每次跑先整个丢弃重建,保证可重复。
#   - 绝不动 starisle / starisle_test / starisle_test_t* —— 那些是别的工作在用。
#   - 端口用 4920,不用默认的 4870(可能被占)。

set -u
cd "$(dirname "$0")/.." || exit 1
REPO_ROOT="$(pwd)"

PORT=4920
DB_NAME="starisle_demo"
DB_URL="postgres://starisle:devpass@localhost:5432/${DB_NAME}"
BASE="http://localhost:${PORT}"
TMP="${REPO_ROOT}/demo/.tmp"
SERVER_PID=""
SERVER_LOG="${TMP}/server.log"

rm -rf "$TMP"
mkdir -p "$TMP"

# ---------- 小工具 ----------

sep()  { printf '\n════════════════════════════════════════════════════════════\n'; }
section() { sep; printf '  %s\n' "$1"; sep; }
note() { printf '  %s\n' "$1"; }

fail() {
  printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  printf '  失败: %s\n' "$1"
  printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  cleanup
  exit 1
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1
    for i in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$SERVER_PID" >/dev/null 2>&1 || break
      sleep 0.3
    done
    if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      taskkill //PID "$SERVER_PID" //F >/dev/null 2>&1
    fi
  fi
}
trap cleanup EXIT

# 从 JSON 响应文件里取字段,避免这台机器上没有 jq。表达式是纯 ASCII JS,
# 文件内容(可能含中文)用 fs.readFileSync 读,不走 argv,不会被吞。
jget() {
  node -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const fn = new Function("d", "return (" + process.argv[2] + ")");
    const v = fn(d);
    process.stdout.write(v === undefined ? "" : (typeof v === "string" ? v : JSON.stringify(v)));
  ' "$1" "$2"
}

assert_status() {
  local got="$1" want="$2" step="$3"
  if [ "$got" != "$want" ]; then
    fail "$step —— 期望 HTTP $want,实际 HTTP $got"
  fi
}

assert_true() {
  local val="$1" step="$2" msg="$3"
  if [ "$val" != "true" ]; then
    fail "$step —— $msg"
  fi
}

# 等服务器答应(GET /api/domains 是公开路由,不需要登录)
wait_for_server() {
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/domains" 2>/dev/null)
    if [ "$code" = "200" ]; then return 0; fi
    if [ -f "$SERVER_LOG" ] && grep -q "已被占用" "$SERVER_LOG" 2>/dev/null; then
      fail "端口 $PORT 已被其它进程占用,换个端口或先关掉那个进程(不是本脚本启动的,不能替你关)"
    fi
    sleep 0.4
  done
  fail "服务器 $BASE 启动后 16 秒没响应,日志见 $SERVER_LOG"
}

start_server() {
  : > "$SERVER_LOG"
  ( DATABASE_URL="$DB_URL" PORT="$PORT" SESSION_SECURE=0 bun app/server.ts >> "$SERVER_LOG" 2>&1 & echo $! > "$TMP/server.pid" )
  sleep 0.3
  SERVER_PID="$(cat "$TMP/server.pid" 2>/dev/null)"
  wait_for_server
}

# ---------- 开场 ----------

section "星屿 Starisle · PostgreSQL 后端演示(从一个空数据库开始)"
note "数据库: $DB_NAME   端口: $PORT   仓库: $REPO_ROOT"

section "准备 0/14 · 重置演示数据库(不碰 starisle / starisle_test*)"
docker exec starisle-db psql -U starisle -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1
docker exec starisle-db psql -U starisle -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DB_NAME};" \
  || fail "准备 0 —— 无法丢弃旧的 ${DB_NAME}"
docker exec starisle-db psql -U starisle -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME};" \
  || fail "准备 0 —— 无法新建 ${DB_NAME}"
note "已丢弃并重建 ${DB_NAME}"

section "准备 0/14 · 跑 migration"
DATABASE_URL="$DB_URL" bun app/db/migrate.ts || fail "准备 0 —— migration 失败"

section "准备 0/14 · 启动服务(端口 $PORT)"
start_server
note "服务已就绪:$BASE  (pid=$SERVER_PID)"

# ================================================================
section "步骤 1/14 · 建站长账号(app/bin/create-admin.js,环境变量路径)"
# ================================================================
ADMIN_OUT="$TMP/step1-admin.txt"
DATABASE_URL="$DB_URL" \
  ADMIN_USER="zhanzhang" \
  ADMIN_PASSWORD="StarisleDemo123!" \
  ADMIN_EMAIL="zhanzhang@starisle.demo" \
  ADMIN_DISPLAY_NAME="星屿站长" \
  bun app/bin/create-admin.ts > "$ADMIN_OUT" 2>&1
if [ $? -ne 0 ]; then
  cat "$ADMIN_OUT"
  fail "步骤 1 —— create-admin.js 非零退出"
fi
cat "$ADMIN_OUT"
grep -q "站长账号已创建" "$ADMIN_OUT" || fail "步骤 1 —— 输出里没看到创建成功的字样"
note "站长账号 zhanzhang 已就绪"

# ================================================================
section "步骤 2/14 · 新人注册(小宇 xiaoyu)"
# ================================================================
cat > "$TMP/req-register.json" <<'EOF'
{"username":"xiaoyu","password":"XiaoyuPass123!","display_name":"小宇",
 "email":"xiaoyu@starisle.demo","repo_url":"https://github.com/xiaoyu/robot-kit",
 "apply_note":"我在做一个面向中学生的开源机器人套件,想加入星屿一起做。"}
EOF
CODE=$(curl -s -o "$TMP/resp2.json" -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data-binary @"$TMP/req-register.json" \
  "$BASE/api/auth/register")
assert_status "$CODE" "200" "步骤 2(注册)"
OK=$(jget "$TMP/resp2.json" 'd.ok')
assert_true "$OK" "步骤 2(注册)" "响应 ok 不是 true: $(cat "$TMP/resp2.json")"
NOTE2=$(jget "$TMP/resp2.json" 'd.note')
note "注册响应: $NOTE2"
note "(这句话就是产品要的效果:提交完不能直接用,要等站长审。)"

# ================================================================
section "步骤 3/14 · 新人现在就想登录 —— 应该被拒(邀请/审核门是真的)"
# ================================================================
cat > "$TMP/req-login-xiaoyu.json" <<'EOF'
{"username":"xiaoyu","password":"XiaoyuPass123!"}
EOF
CODE=$(curl -s -o "$TMP/resp3.json" -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data-binary @"$TMP/req-login-xiaoyu.json" \
  "$BASE/api/auth/login")
assert_status "$CODE" "403" "步骤 3(未审核用户登录应 403)"
ERR3=$(jget "$TMP/resp3.json" 'd.error')
note "HTTP 403,理由: $ERR3"
note "*** 这一步证明:光注册拿不到账号,必须站长点头。 ***"

# ================================================================
section "步骤 4/14 · 匿名看成员列表 —— 小宇不应该出现(还没批)"
# ================================================================
CODE=$(curl -s -o "$TMP/resp4.json" -w '%{http_code}' "$BASE/api/members")
assert_status "$CODE" "200" "步骤 4(匿名成员列表)"
HAS4=$(jget "$TMP/resp4.json" 'd.members.some(m=>m.username==="xiaoyu")')
if [ "$HAS4" != "false" ]; then fail "步骤 4 —— 小宇不该出现在成员列表里,但出现了"; fi
CNT4=$(jget "$TMP/resp4.json" 'd.members.length')
note "当前已通过审核的成员数: $CNT4(小宇不在里面,符合预期)"

# ================================================================
section "步骤 5/14 · 站长登录,拿会话 cookie"
# ================================================================
cat > "$TMP/req-login-owner.json" <<'EOF'
{"username":"zhanzhang","password":"StarisleDemo123!"}
EOF
CODE=$(curl -s -o "$TMP/resp5.json" -D "$TMP/headers5.txt" -c "$TMP/cookie_owner.txt" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' --data-binary @"$TMP/req-login-owner.json" \
  "$BASE/api/auth/login")
assert_status "$CODE" "200" "步骤 5(站长登录)"
OK5=$(jget "$TMP/resp5.json" 'd.ok')
assert_true "$OK5" "步骤 5(站长登录)" "登录响应 ok 不是 true"
SETCOOKIE5=$(grep -i '^Set-Cookie:' "$TMP/headers5.txt" | head -1)
if [ -z "$SETCOOKIE5" ]; then fail "步骤 5 —— 响应头里没有 Set-Cookie,会话没建立"; fi
if ! grep -q "starisle_sid" "$TMP/cookie_owner.txt"; then fail "步骤 5 —— cookie jar 里没有 starisle_sid"; fi
note "服务端下发的会话 cookie: $SETCOOKIE5"
ROLE5=$(jget "$TMP/resp5.json" 'd.user.role')
note "登录身份确认: role=$ROLE5"

# ================================================================
section "步骤 6/14 · 站长查看待审申请 —— 应该看到小宇,附判断所需字段"
# ================================================================
CODE=$(curl -s -o "$TMP/resp6.json" -w '%{http_code}' -b "$TMP/cookie_owner.txt" \
  "$BASE/api/admin/users/pending")
assert_status "$CODE" "200" "步骤 6(待审用户列表)"
HAS6=$(jget "$TMP/resp6.json" 'd.users.some(u=>u.username==="xiaoyu")')
assert_true "$HAS6" "步骤 6" "待审列表里没有小宇"
XIAOYU_ID=$(jget "$TMP/resp6.json" 'd.users.find(u=>u.username==="xiaoyu").id')
XIAOYU_EMAIL=$(jget "$TMP/resp6.json" 'd.users.find(u=>u.username==="xiaoyu").email')
XIAOYU_NOTE=$(jget "$TMP/resp6.json" 'd.users.find(u=>u.username==="xiaoyu").apply_note')
XIAOYU_REPO=$(jget "$TMP/resp6.json" 'd.users.find(u=>u.username==="xiaoyu").repo_url')
note "待审申请 #$XIAOYU_ID"
note "  用户名:   xiaoyu"
note "  邮箱:     $XIAOYU_EMAIL"
note "  仓库:     $XIAOYU_REPO"
note "  申请说明: $XIAOYU_NOTE"
note "(这些字段站长登录才能看,下面步骤 13 会证明匿名看不到)"

# ================================================================
section "步骤 7/14 · 站长批准小宇"
# ================================================================
cat > "$TMP/req-approve-user.json" <<'EOF'
{"decision":"approve"}
EOF
CODE=$(curl -s -o "$TMP/resp7.json" -w '%{http_code}' -b "$TMP/cookie_owner.txt" \
  -X POST -H 'Content-Type: application/json' --data-binary @"$TMP/req-approve-user.json" \
  "$BASE/api/admin/users/${XIAOYU_ID}/review")
assert_status "$CODE" "200" "步骤 7(批准用户)"
ST7=$(jget "$TMP/resp7.json" 'd.status')
if [ "$ST7" != "approved" ]; then fail "步骤 7 —— 批准后 status 应为 approved,实际 $ST7"; fi
note "小宇的账号状态: $ST7"

# ================================================================
section "步骤 8/14 · 小宇现在登录 —— 应该成功,拿到自己的 cookie"
# ================================================================
CODE=$(curl -s -o "$TMP/resp8.json" -D "$TMP/headers8.txt" -c "$TMP/cookie_xiaoyu.txt" -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' --data-binary @"$TMP/req-login-xiaoyu.json" \
  "$BASE/api/auth/login")
assert_status "$CODE" "200" "步骤 8(小宇登录)"
if ! grep -q "starisle_sid" "$TMP/cookie_xiaoyu.txt"; then fail "步骤 8 —— 小宇没拿到会话 cookie"; fi
note "小宇登录成功,拿到独立于站长的会话 cookie"

# ================================================================
section "步骤 9/14 · 小宇发起一个项目"
# ================================================================
cat > "$TMP/req-project.json" <<'EOF'
{"name":"青少年机器人套件","tagline":"给中学生的开源机器人入门套件",
 "description":"一个面向中学生的开源机器人教学套件,包含控制板设计、图形化编程环境和十个由浅入深的教学案例,目标是让没有电子基础的学生也能在两周内做出会动的机器人。"}
EOF
CODE=$(curl -s -o "$TMP/resp9.json" -w '%{http_code}' -b "$TMP/cookie_xiaoyu.txt" \
  -X POST -H 'Content-Type: application/json' --data-binary @"$TMP/req-project.json" \
  "$BASE/api/projects")
assert_status "$CODE" "200" "步骤 9(发起项目)"
OK9=$(jget "$TMP/resp9.json" 'd.ok')
assert_true "$OK9" "步骤 9" "发起项目响应 ok 不是 true"
SLUG=$(jget "$TMP/resp9.json" 'd.project.slug')
PST9=$(jget "$TMP/resp9.json" 'd.project.status')
if [ -z "$SLUG" ]; then fail "步骤 9 —— 没拿到项目 slug"; fi
note "项目已提交: slug=$SLUG, status=$PST9(应为 pending)"

# ================================================================
section "步骤 10/14 · 匿名看项目列表 —— 这个项目还不该出现(待审)"
# ================================================================
CODE=$(curl -s -o "$TMP/resp10.json" -w '%{http_code}' "$BASE/api/projects")
assert_status "$CODE" "200" "步骤 10(匿名项目列表·审核前)"
HAS10=$(jget "$TMP/resp10.json" "d.projects.some(p=>p.slug===\"${SLUG}\")")
if [ "$HAS10" != "false" ]; then fail "步骤 10 —— 项目还没审核,不该出现在匿名列表里"; fi
note "确认:匿名列表里还看不到「$SLUG」(等待站长审核)"

# ================================================================
section "步骤 11/14 · 站长批准项目"
# ================================================================
CODE=$(curl -s -o "$TMP/resp11a.json" -w '%{http_code}' -b "$TMP/cookie_owner.txt" \
  "$BASE/api/admin/projects/pending")
assert_status "$CODE" "200" "步骤 11(待审项目列表)"
PROJECT_ID=$(jget "$TMP/resp11a.json" "d.projects.find(p=>p.slug===\"${SLUG}\").id")
if [ -z "$PROJECT_ID" ]; then fail "步骤 11 —— 待审项目列表里找不到 $SLUG"; fi

cat > "$TMP/req-approve-project.json" <<'EOF'
{"decision":"approve"}
EOF
CODE=$(curl -s -o "$TMP/resp11b.json" -w '%{http_code}' -b "$TMP/cookie_owner.txt" \
  -X POST -H 'Content-Type: application/json' --data-binary @"$TMP/req-approve-project.json" \
  "$BASE/api/admin/projects/${PROJECT_ID}/review")
assert_status "$CODE" "200" "步骤 11(批准项目)"
ST11=$(jget "$TMP/resp11b.json" 'd.status')
if [ "$ST11" != "approved" ]; then fail "步骤 11 —— 批准后 status 应为 approved,实际 $ST11"; fi
note "项目 #$PROJECT_ID 已批准上线"

# ================================================================
section "步骤 12/14 · 匿名再看项目列表 —— 现在应该在了,且属于小宇"
# ================================================================
CODE=$(curl -s -o "$TMP/resp12.json" -w '%{http_code}' "$BASE/api/projects")
assert_status "$CODE" "200" "步骤 12(匿名项目列表·审核后)"
HAS12=$(jget "$TMP/resp12.json" "d.projects.some(p=>p.slug===\"${SLUG}\")")
assert_true "$HAS12" "步骤 12" "项目已批准,但匿名列表里看不到"
OWNER12=$(jget "$TMP/resp12.json" "d.projects.find(p=>p.slug===\"${SLUG}\").owner.username")
if [ "$OWNER12" != "xiaoyu" ]; then
  fail "步骤 12 —— 项目 owner 应该是 xiaoyu(发起人),实际是 $OWNER12"
fi
note ">>> 项目「$SLUG」owner 字段 = \"$OWNER12\" <<<"
note ">>> 不是站长 zhanzhang,是发起人小宇本人 —— 这就是「绑到我身上」。 <<<"

# ================================================================
section "步骤 13/14 · 匿名请求后台待审用户接口 —— 应该 401(PII 默认拒绝)"
# ================================================================
CODE=$(curl -s -o "$TMP/resp13.json" -w '%{http_code}' "$BASE/api/admin/users/pending")
assert_status "$CODE" "401" "步骤 13(匿名访问待审用户接口应 401)"
ERR13=$(jget "$TMP/resp13.json" 'd.error')
note "HTTP 401,理由: $ERR13"
note "*** 小宇的邮箱、申请说明这些 PII,不登录站长身份根本读不到。 ***"

# ================================================================
section "★★★ 步骤 14/14 · 重启服务器进程,数据还在不在?★★★"
# ================================================================
note "这是整场演示最重要的一步:旧的内存版每次重启就清空,新版是真 PostgreSQL。"
note "现在真的杀掉 node 进程、另起一个新进程,再问一遍 /api/projects。"
OLD_PID="$SERVER_PID"
kill "$OLD_PID" >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$OLD_PID" >/dev/null 2>&1 || break
  sleep 0.3
done
if kill -0 "$OLD_PID" >/dev/null 2>&1; then
  taskkill //PID "$OLD_PID" //F >/dev/null 2>&1
  sleep 0.5
fi
note "旧进程(pid=$OLD_PID)已终止。"
SERVER_PID=""
start_server
note "新进程(pid=$SERVER_PID)已就绪 —— 注意这是一个全新的 Node 进程,内存里什么都没有。"

CODE=$(curl -s -o "$TMP/resp14.json" -w '%{http_code}' "$BASE/api/projects")
assert_status "$CODE" "200" "步骤 14(重启后查询项目)"
HAS14=$(jget "$TMP/resp14.json" "d.projects.some(p=>p.slug===\"${SLUG}\")")
assert_true "$HAS14" "步骤 14" "重启后项目「$SLUG」消失了 —— 数据没有真正落到 PostgreSQL"
OWNER14=$(jget "$TMP/resp14.json" "d.projects.find(p=>p.slug===\"${SLUG}\").owner.username")
if [ "$OWNER14" != "xiaoyu" ]; then
  fail "步骤 14 —— 重启后 owner 变成了 $OWNER14(应该还是 xiaoyu)"
fi
sep
note "重启前: 项目「$SLUG」存在,owner=xiaoyu"
note "重启后: 项目「$SLUG」存在,owner=xiaoyu   ← 完全没变"
note ""
note "数据活在 PostgreSQL 里,不活在进程内存里。进程可以随便重启、崩溃、重新部署,"
note "用户和项目都不会凭空消失 —— 这正是这次重写要解决的问题。"
sep

# ================================================================
section "全部 14 步通过 ✓"
# ================================================================
note "站长: zhanzhang / StarisleDemo123!"
note "成员: xiaoyu / XiaoyuPass123!"
note "项目: $SLUG (owner=xiaoyu)"
note "数据库: $DB_NAME(演示专用,与 starisle / starisle_test* 完全隔离)"

exit 0
