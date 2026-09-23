# 部署 · Deploy

星屿部署到**你自己的服务器**:Docker + Docker Compose,一个 `app` 容器(Node,内含编译好的前端)和一个 `db` 容器(PostgreSQL 17)。**没有 Cloudflare 了** —— Worker、Durable Object、`wrangler.jsonc`、`worker/` 目录都随重写整体删除,下面这份文档不是那份文档的增补,是替换。

这份文档是给人读了照着敲命令用的**运行手册**,不是概念性介绍。命令假定在仓库根目录(`docker-compose.yml` 所在目录)执行,shell 是 bash(远程服务器上跑 Linux)。

---

## 0. 现状核对(写这份文档时做过的验证)

镜像构建、迁移在容器启动时自动执行、容器重启后数据不丢、隔离测试栈起停不影响宿主上已有的 `starisle-db` 容器 —— 这几条在 Task 20(`.superpowers/sdd/2026-08-17-postgres-accounts/task-20-report.md`)里已经用真实 `docker compose build` / `docker run` / `docker exec` 命令跑通并留了完整 transcript,包括:

- `docker run --rm starisle-t20-app ls app/public-dist` 确认镜像里真的有 `index.html`/`admin.html`/`assets/`(前端是在镜像内构建的,不是从宿主拷贝)。
- 容器自己的 Postgres(不是宿主已有的库)里跑完 migration 后 `domains` 表有 6 行,证明迁移是这次容器启动时真正执行的。
- 注册一个用户 → `docker compose restart app` → 再登录,返回的还是"审核中"而不是"用户不存在",证明数据在容器重启后完好。
- 隔离测试栈 `down -v` 后,原本一直在跑的 `starisle-db` 容器全程未受影响。

本文档不重复这几条验证,直接引用其结论。本次(Task 21)另外单独跑通的是下面第 4 节列出的四条 API 级检查,针对一个已经跑着当前代码、连着真实账号数据库的服务器实测,输出原样贴在下面,不是编的。

---

## 1. 服务器前提条件

- 一台能装 Docker 的 Linux 服务器(Debian/Ubuntu 都行),装好 **Docker Engine + Compose plugin**(`docker compose version` 能跑通,这份仓库用的是 Compose v2 语法)。
- **数据库需要建扩展的权限(仅当你不用这份仓库自带的 `db` 服务时才需要关心)。** `app/db/migrations/001_init.sql` 第一行是 `CREATE EXTENSION IF NOT EXISTS citext`,这条语句在大多数托管 PostgreSQL(RDS、Cloud SQL 等)上**要求超级用户权限**,普通业务账号跑不过去,迁移会直接报错失败。这份仓库自带的 `db` 服务(`postgres:17-alpine` 镜像)之所以能跑通,是因为 compose 起的 `starisle` 角色本身就是超级用户 —— 这是官方 Postgres 镜像默认行为,不是这份 compose 文件额外配置的。如果打算部署到自己管理的 `db` 容器以外的地方(托管 Postgres、别人维护的共享实例),要么找运维用超级用户身份**预先**手动跑一遍 `CREATE EXTENSION citext`(之后普通账号迁移就不会再碰这条语句,`schema_migrations` 记录后也不会重跑),要么确认目标服务允许你临时提权执行这条语句。
- 一个指向这台服务器公网 IP 的域名(A/AAAA 记录)。**本任务不做这一步** —— DNS 修改是部署者自己的操作,不在这份文档的执行范围里。
- **TLS 终止**:这个仓库里的 `app` 容器只讲明文 HTTP(监听 `PORT`,默认 4870),**不自带 TLS**。生产环境必须在它前面接一层反向代理(Caddy / nginx / Traefik 任选)做 HTTPS 终止,再转发到 `app` 容器暴露的宿主端口。反向代理的具体配置这份文档不展开(跟这个项目本身无关),但**没有这一层,前端拿不到 `Secure` cookie 该有的 HTTPS 上下文**,`SESSION_SECURE=1`(见下一节)也就没有意义。
- **`/api/auth/*` 的限流是必需项,不是可选加固。** 应用代码里没有速率限制 —— 每次登录尝试都会跑一次 scrypt(`N=2^16`),单次校验约占 64MB 内存;`/api/auth/login`、`/api/auth/register` 两个端点匿名可达,不限流的话几个并发请求就能把服务器内存和 CPU 顶到接近 libuv 线程池上限,而且这是当前系统对"暴力破解站长密码"唯一的防线(站长密码只要求 8 位)。反向代理必须在转发到 `app` 之前,对这两个端点单独限速。下面是一份可以直接抄的 nginx 配置(Caddy/Traefik 效果等价,自行翻译):

  ```nginx
  # http {} 块级别,和 server {} 平级 —— 定义限流区,按客户端 IP 计数,
  # 10MB 大约能存 16 万个 IP 的状态,每 IP 每分钟最多 5 次请求
  limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=5r/m;

  server {
      listen 443 ssl;
      server_name your-domain.example;

      # ... TLS 证书等其它配置省略 ...

      # /api/auth/* 单独限流:突发允许再排 5 个,超出直接 429,不排队等
      location /api/auth/ {
          limit_req zone=auth_limit burst=5 nodelay;
          limit_req_status 429;
          proxy_pass http://127.0.0.1:4930;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }

      # 其余 /api/* 和静态资源正常转发,不限流
      location / {
          proxy_pass http://127.0.0.1:4930;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
      }
  }
  ```

  `proxy_pass` 指向的 `127.0.0.1:4930` 是 `docker-compose.yml` 里 `app` 服务映射到宿主的端口(见下一段)。这条限流规则只挡住"打 API"的暴力破解,不能替代强密码 —— 两者都要有。

`docker-compose.yml` 现状(仓库根目录):`app` 服务把容器内部端口(`PORT`,默认 4870)映射到宿主的 **4930**;`db` 服务的容器名固定是 `starisle-db`,宿主端口固定 **5432**。这两个值都是写死的字面量,不是从 `.env` 读的 —— 也就是说**同一台宿主机同时只能跑一份这个 compose 栈**(第二份会因为容器名/端口冲突起不来)。生产环境这通常不是问题(一台服务器一份生产部署),但如果要在同一台机器上并行跑一个隔离的验证栈,需要用 `-f` 叠加一份覆盖文件重新指定端口和容器名(本次验证就是这么做的,细节见第 0 节引用的 Task 20 报告)。

---

## 2. 生成并设置密钥

仓库根目录建一个 `.env` 文件(`docker compose` 会自动读取同目录下的 `.env`;这个文件本身已被 `.gitignore` 忽略,不会被提交):

```bash
# 生成一个强 Postgres 密码(hex,只含 0-9a-f,原样放进 URI 不需要转义)
openssl rand -hex 32
```

写入 `.env`:

```dotenv
# db 服务用这个初始化 Postgres 密码(见 docker-compose.yml 里的
# POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-devpass} —— 不设就是 devpass,生产必须覆盖)
POSTGRES_PASSWORD=<上面生成的强密码>

# app 服务连库用的完整连接串。host 必须是 compose 里的服务名 db,不是 localhost——
# app 和 db 是两个容器,靠 compose 内部网络按服务名互相访问。密码要和上面那行一致。
# 密码还必须落在 URI 安全字符集里:裸的 / ? # 会把这个串解析坏,app 容器起不来,
# 而报错完全指不到密码这一步。app/db/pool.js 把 DATABASE_URL 原样交给 new Pool(),
# pg 用 pg-connection-string 解析(内部走 WHATWG new URL())——实测这三个字符一律
# 抛 Invalid URL;: 和 @ 出现在密码里反而是安全的,会被正确解析进 password。
# 上面用 openssl rand -hex 正是为了绕开这点:hex 只含 0-9a-f。
# 想用别的生成方式(例如 openssl rand -base64 24,产出 32 个 base64 字符,字母表含 /,
# 出现至少一个的概率约四成),就先把密码 percent-encode 再填进来——实测 %2F 会被
# 正确解码回 /,这条路走得通。
DATABASE_URL=postgres://starisle:<和上面同一个密码>@db:5432/starisle

# 生产必须设成 1:session cookie 才会带 Secure 标记(见 app/server.js 的
# serializeCookie(),SECURE = process.env.SESSION_SECURE === '1')。
# 不设就是 0,cookie 没有 Secure——在只有反向代理做了 HTTPS 终止、后端仍是明文
# HTTP 的部署形态下,Secure 标记本身仍然有意义(防止 cookie 被明文 HTTP 探测/降级
# 攻击拿到),所以生产环境不要漏设这一条。
SESSION_SECURE=1
```

`POSTGRES_PASSWORD` 只在 `db` 容器**第一次初始化数据目录时**生效 —— 如果这台机器之前已经用默认密码 `devpass` 起过一次(比如先拿默认值跑通了再回来改密码),换密码前需要要么整个卷重来(`docker compose down -v`,**会丢数据**,只适合还没正式上线时做),要么进容器用 `ALTER USER` 手动改密码并同步更新 `DATABASE_URL`。全新服务器上首次部署不会遇到这个问题。

---

## 3. 首次启动

```bash
docker compose up -d
```

这一条命令会:构建 `app` 镜像(多阶段构建,第一阶段在镜像内装前端依赖并 `npm run build`;第二阶段只装生产依赖(仅 `pg`)、拷入后端源码 `app/`,再把第一阶段的前端产物覆盖到 `app/public-dist`,见 `Dockerfile`)、拉起 `db`(等它 healthcheck 通过)、再启动 `app`。`app` 容器的启动命令是 `sh -c "node app/db/migrate.js && node app/server.js"`(见 `Dockerfile` 的 `CMD`)—— **迁移在每次容器启动时自动跑,不需要单独执行一步"迁移"**;`app/db/migrate.js` 是幂等的(已应用过的文件名记在 `schema_migrations` 表里,重跑会跳过)。

```bash
# 看一眼迁移和启动日志
docker compose logs app
```

应该能看到类似:

```
  应用 001_init.sql
  应用 002_project_interactions.sql
migration 完成

  ✦ 星屿 Starisle
  主站     http://localhost:4870/
  控制台   http://localhost:4870/admin.html
```

### 建站长账号

`app/bin/create-admin.js` 平时是交互式问答,但读到 `ADMIN_USER`/`ADMIN_PASSWORD` 这两个环境变量时会走非交互路径(专门为首次开机这种场景设计,见该文件 `main()` 里的分支),`ADMIN_EMAIL` 不给的话会兜底成 `<用户名>@localhost`,`ADMIN_DISPLAY_NAME` 不给的话会兜底成用户名本身:

```bash
docker compose exec \
  -e ADMIN_USER=zhanzhang \
  -e ADMIN_PASSWORD='<一个至少 8 位的强密码,别用示例里这串>' \
  -e ADMIN_EMAIL=owner@your-domain.example \
  -e ADMIN_DISPLAY_NAME='站长的显示名' \
  app node app/bin/create-admin.js
```

成功会打印 `站长账号已创建:zhanzhang(id=1)` 这样一行。这个账号 `role='admin', status='approved'`,直接能登录,不经过注册审核流程。

---

## 4. 验证部署

下面四条是这份手册**实测跑过**的检查,不是照着代码猜的 —— 针对一台已经在跑当前代码、连着带真实账号的数据库的服务器,原样贴出实际返回。

**端口说明:`docker-compose.yml` 把 `app` 直接映射到宿主的 4930(不是 80),而这份文档不配置反向代理去监听 80/443 转发到它**(§1 的限流反代是必需的安全前提,但把它接到 DNS 域名、80/443 端口上是部署者自己的操作,不在这份手册的执行范围)。所以下面四条命令直接打 `<host>:4930`,绕过反向代理直连 `app` 容器 —— 这是验证 `app`/`db` 本身工作正常的最短路径。等反向代理和域名接好之后,同样的路径应该换成 `https://<你的域名>/api/...`(经过 §1 的限流规则)来验证。

命令里的 `4930` 是 `docker-compose.yml` 发布的宿主端口(见第 1 节),跟容器内部的 `PORT`(默认 4870)不是一回事 —— 端口映射写成字面量 `"4930:${PORT:-4870}"`,即使在 `.env` 里改了 `PORT`,宿主侧仍然是 4930,所以这里一律写 4930,不要照抄第 3 节日志里的 4870(那是容器内部的地址)。等按第 1 节在前面接好反向代理做 HTTPS 终止之后,把 `http://<host>:4930` 换成 `https://<你的域名>`(协议也要一起换 —— 多数反代会把 http 跳到 https,继续写 http 容易拿到一个 301 而不是你要验的那个响应)。

```bash
$ curl -s -o /dev/null -w '%{http_code}\n' http://<host>:4930/api/domains
200
```

```bash
$ curl -s -w '\n%{http_code}\n' http://<host>:4930/api/admin/users/pending
{"error":"需要站长身份","code":"admin_required"}
401
```
匿名访问后台端点,默认拒绝生效(见 `docs/API.md` 的鉴权一节)。

```bash
$ curl -s -w '\n%{http_code}\n' -X POST http://<host>:4930/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"t21doccheck","password":"pw12345678","display_name":"T21 Doc Check",
       "email":"t21doccheck@example.com","apply_note":"task-21 runbook verification user, not a real member"}'
{"ok":true,"note":"已提交,站长审核通过后即可登录。"}
200
```

```bash
$ curl -s -w '\n%{http_code}\n' -X POST http://<host>:4930/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"t21doccheck","password":"pw12345678"}'
{"error":"申请审核中,通过后即可登录"}
403
```
刚注册但还没被站长审核的账号,登录被拒且给出明确原因(不是"账号不存在"),这正是"注册 → 审核 → 登录"这条链路在真实运行的证据。

### 数据在重启后仍在

不用每次都手动重新验证这一条 —— Task 20 报告(见第 0 节)已经完整跑过"注册用户 → `docker compose restart app` → 再登录,状态仍是同一个 `pending` 用户,不是`用户不存在`"这条链路,证据是同一套 Docker 镜像 + 同一个 `app/db/migrate.js`/`app/server.js` 组合。如果想自己再确认一遍:

```bash
docker compose restart app
docker compose logs app --tail 20   # 应该看到 “跳过 001_init.sql(已应用)”“跳过 002_project_interactions.sql(已应用)”
                                    # 再跟一行 “migration 完成” —— 迁移正确跳过而不是重跑(出现 “应用 xxx” 才是异常)。
                                    # 不想数行数就用 docker compose logs app --tail 40 | grep -E '跳过|应用'
curl -s -X POST http://<host>:4930/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"t21doccheck","password":"pw12345678"}'
# 期望仍是 {"error":"申请审核中,通过后即可登录"},不是别的错误
```

---

## 5. 备份

**这个数据库现在存的是真实用户账号(用户名、密码哈希、真实邮箱地址),不再是可以随便丢弃重来的演示数据。** 备份和访问都要按处理真实个人数据的标准对待:导出的备份文件本身就包含邮箱地址,不能随手传去没有访问控制的地方(公共 issue、聊天群文件、明文对象存储等)。

另外,项目的路演海报是以 base64 data URI 直接内联在 `projects.poster` 这个 text 列里的(`002_project_interactions.sql`,不走对象存储;单张上限 700,000 字符,约 512KB 原图,见 `app/routes/projects.js` 的 `POSTER_MAX_CHARS`)。所以下面这条整库导出的产物里除了邮箱,还包含用户上传的图片内容,体积也会随海报数量线性增长 —— 按含用户上传内容的备份对待,并留意磁盘。

```bash
# 备份(在宿主机上执行,产物落在宿主机,不留在容器里)
docker compose exec db pg_dump -U starisle starisle > backup-$(date +%F).sql
```

数据实际落盘在 Docker 具名卷 `pgdata`(`docker-compose.yml` 里 `volumes: pgdata:/var/lib/postgresql/data`,compose 项目名会给它加前缀,比如 `starisle_pgdata`):

```bash
docker volume inspect starisle_pgdata   # 查看卷在宿主机文件系统上的真实路径(Mountpoint 字段)
```

`docker compose down`(不带 `-v`)不会删这个卷,数据留着;`docker compose down -v` **会把卷一起删掉**,生产环境不要对着这条命令手滑。

---

## 6. 旧的 Cloudflare 部署该怎么办

**`starisle.demo.muran.tech` 这个 Cloudflare Worker 目前还挂着,今天任何人访问这个域名看到的都是旧的、纯内存、reload 就清空的那版 demo** —— 它没有被这次重写自动下线,重写只是删掉了本地仓库里的 `worker/`、`wrangler.jsonc` 源码,没有触碰已经部署在 Cloudflare 上的那份旧代码。这意味着:**新版(这份文档描述的 Docker + PostgreSQL 版本)部署到位之前,公网上唯一能看到的还是旧 demo**,两者目前互不相关、互不影响。

这份文档**不执行**下线/改域名这一步 —— 按任务边界,不碰 Cloudflare、不碰 DNS、不跑 `wrangler`。留给部署者自己决定并执行的选项:

- 新版上线后,把 `starisle.demo.muran.tech` 这条 DNS 记录改指向新服务器(这台跑 Docker 的机器),同时可以把旧 Worker `wrangler delete` 掉或留着不再路由流量。
- 或者干脆换一个新域名给新版用,旧 Worker 单独找时间下线。

不管选哪种,**在部署者主动做这一步之前,不要在任何对外文案里说"已经上线"** —— 公网 URL 现在指向的还是旧代码。
