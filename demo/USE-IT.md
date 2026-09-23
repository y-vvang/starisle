# 现在就能用：账号 / 项目 / 站长审核

服务已在跑：**http://localhost:4940**，数据在 PostgreSQL 的 `starisle` 库里，**重启不丢**。

> ⚠️ **现在只有 API，没有网页界面。** 前端还在重建中（旧前端调的是已删除的接口）。
> 下面每条命令都是可以直接粘进 Git Bash 跑的。

## 现有账号

| 用户名 | 密码 | 角色 |
|---|---|---|
| `zhanzhang` | `<站长真实密码，找部署这份 demo 的人要，别抄这里>` | 站长（管理员） |
| `xiaolin` | `XiaolinPw2026` | 普通成员（已审核通过） |

## 准备（每次开新终端跑一次）

```bash
cd "E:/Projects/AI youth community"
B=http://localhost:4940
J='content-type: application/json'
D=/tmp/starisle && mkdir -p $D
```

---

## 一、站长登录（拿到管理员 Cookie）

```bash
printf '%s' '{"username":"zhanzhang","password":"<换成上面表格里那个真实密码>"}' > $D/a.json
curl -s -c $D/admin.jar -X POST -H "$J" --data-binary @$D/a.json $B/api/auth/login
```

之后所有站长操作都带 `-b $D/admin.jar`。

## 二、加一个新账号（模拟别人来申请）

**中文必须写进文件再用 `--data-binary @文件`。** 直接把中文当命令行参数传，这台机器的 Git Bash 会静默把它变成乱码 —— 这个坑今天已经踩过一次。

```bash
node -e "require('fs').writeFileSync('$D/reg.json', JSON.stringify({
  username: 'xiaowang',
  password: 'XiaowangPw2026',
  display_name: '小王',
  email: 'xiaowang@example.com',
  repo_url: 'https://gitee.com/xiaowang/demo',
  apply_note: '我在学校做过一个自习室占座查询的小程序,想加入社区'
}), 'utf8')"

curl -s -X POST -H "$J" --data-binary @$D/reg.json $B/api/auth/register
```

→ `{"ok":true,"note":"已提交,站长审核通过后即可登录。"}`

**此时他还登不进来**（这就是邀请制）：

```bash
printf '%s' '{"username":"xiaowang","password":"XiaowangPw2026"}' > $D/w.json
curl -s -X POST -H "$J" --data-binary @$D/w.json $B/api/auth/login
```

→ `{"error":"申请审核中,通过后即可登录"}`

## 三、站长审核

看待审队列（这里能看到邮箱和申请说明，匿名访问是 401）：

```bash
curl -s -b $D/admin.jar $B/api/admin/users/pending
```

批准（把 `3` 换成上面看到的 id）：

```bash
curl -s -b $D/admin.jar -X POST -H "$J" -d '{"decision":"approve"}' \
  $B/api/admin/users/3/review
```

拒绝就把 `approve` 换成 `reject`。

现在他能登录了：

```bash
curl -s -c $D/wang.jar -X POST -H "$J" --data-binary @$D/w.json $B/api/auth/login
```

## 四、成员发项目

```bash
node -e "require('fs').writeFileSync('$D/p.json', JSON.stringify({
  name: '自习室占座查询',
  tagline: '实时看哪个自习室还有空位',
  description: '接入学校自习室的摄像头计数数据,做一个手机上能查空位的小程序,已经在本校试用两个月。',
  repo_url: 'https://gitee.com/xiaowang/demo',
  domain_id: 'edu'
}), 'utf8')"

curl -s -b $D/wang.jar -X POST -H "$J" --data-binary @$D/p.json $B/api/projects
```

→ `status: "pending"`，**公开列表里看不到**：

```bash
curl -s $B/api/projects
```

## 五、站长批准项目

```bash
curl -s -b $D/admin.jar $B/api/admin/projects/pending
curl -s -b $D/admin.jar -X POST -H "$J" -d '{"decision":"approve"}' \
  $B/api/admin/projects/2/review
```

现在公开可见，且 `owner` 是发起人本人：

```bash
curl -s $B/api/projects
```

---

## 六个领域（发项目时 `domain_id` 用这些）

`agent`（Agent 与工具）· `edu`（教育公平）· `climate`（气候与环境）
`health`（医疗健康）· `creative`（创意与艺术）· `infra`（开源基础设施）

---

## 已知的两件事

**1. 中文项目名会得到随机 slug。** 比如「错题整理助手」的 slug 是 `p-50b7cb`。
因为 slug 只保留字母数字，纯中文名 slug 化后为空，就回退成 `p-<随机>`。
如果希望 URL 好看，项目名里带一段英文（比如「错题整理助手 NoteFix」→ `notefix`）。

**2. 关闭注册**（不想再收人的时候）：

```bash
curl -s -b $D/admin.jar -X PATCH -H "$J" -d '{"registration_open":false}' \
  $B/api/admin/settings
```

关掉之后任何人再注册都会拿到 403。

---

## 服务管理

```bash
# 看还在不在
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4940/api/domains

# 重新启动（数据不会丢，这是重点）
DATABASE_URL='postgres://starisle:devpass@localhost:5432/starisle' PORT=4940 node app/server.js

# 直接查库
docker exec starisle-db psql -U starisle -d starisle -c "SELECT id,username,role,status FROM users;"
docker exec starisle-db psql -U starisle -d starisle -c "SELECT id,slug,name,status,owner_id FROM projects;"
```
