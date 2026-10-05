# 小剧场演出提示单（Backstage Cue Sheet）

面向小剧场演出的本地化提示单系统：导演维护**按顺序排列、指定一个或多个岗位**的提示项，**发布后生成不可变版本**；每场演出选定一个版本开场，岗位凭**专属口令**进入当场页面，只能确认**分配给自己**的提示项。系统在服务端强制顺序互锁、全员完成、幂等去重，并通过 WebSocket 把各岗位确认与事件顺序实时同步给所有人。

- 后端：Node.js + TypeScript + Express + better-sqlite3 + ws
- 前端：原生 HTML/CSS/JavaScript（无需构建，浏览器直接打开）
- 存储：SQLite 单文件，开箱即用

---

## 一、一键启动（Docker Compose，推荐）

需要 Docker 20.10+ 与 Compose v2。

```bash
docker compose up -d --build
```

首次启动会自动构建镜像、安装依赖、初始化数据库（自动建库建表），随后即可访问：

| 入口 | 地址 |
| --- | --- |
| 首页（入口导航） | http://localhost:8080/ |
| 🎬 导演工作台 | http://localhost:8080/director.html |
| 📟 岗位确认端 | http://localhost:8080/show.html |
| 健康检查 | http://localhost:8080/api/health |

默认导演口令：**`director`**（强烈建议在 Compose 环境变量中修改，见下）。

常用命令：

```bash
docker compose logs -f        # 查看日志
docker compose restart        # 重启
docker compose down           # 停止并移除容器（数据保留在命名卷 cue-data 中）
docker compose down -v        # 停止并同时删除演出数据
```

数据保存在 Docker 命名卷 `cue-data` 内的 `/data/cues.db`（SQLite，含 WAL 文件）。

---

## 二、本地直接运行（不用 Docker）

要求 Node.js 20+（better-sqlite3 安装时需要可用的原生构建环境，常见系统自带即可）。

```bash
npm install        # 安装依赖（含 better-sqlite3 原生编译）
npm run build      # 编译 TypeScript 到 dist/
npm start          # 启动服务，默认监听 0.0.0.0:8080
```

开发时可另开一个终端执行 `npm run dev`（tsc 监听重编译）。

### 端到端冒烟测试（可选）

仓库内置覆盖全部业务规则的接口测试（42 项断言：顺序互锁、全员完成、幂等、越权/版本不符/口令错误拒绝且不写库、事件顺序、WS 同步等）。对**全新空库**运行：

```bash
# 终端 1
DB_PATH=/tmp/test.db DIRECTOR_PASSWORD=dir1234 PORT=8080 npm start
# 终端 2
npm run smoke
```

---

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP/WebSocket 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/cues.db` | SQLite 数据库文件路径（容器内为 `/data/cues.db`） |
| `DIRECTOR_PASSWORD` | `director` | **首次启动**初始化的导演口令；之后以数据库中修改后的口令为准 |

Compose 中修改端口或口令：编辑 `docker-compose.yml` 的 `ports` 与 `environment`，例如改为 9000 端口：

```yaml
ports:
  - "9000:8080"
environment:
  DIRECTOR_PASSWORD: "你的强口令"
```

> 岗位口令由导演在“④ 岗位与口令”中创建/重置，与导演口令相互独立；口令均以 scrypt + 随机盐哈希存储。

---

## 四、使用流程

### 导演（`/director.html`）

1. 使用导演口令登录。
2. **④ 岗位与口令**：创建岗位（灯光、音响、舞台监督……）及各自的专属口令；可改名、重置口令。
3. **① 提示项草稿**：按顺序编排提示项，每条勾选**一个或多个岗位**，可上移/下移、编辑、删除。
4. **② 版本发布**：把当前草稿发布为**不可变版本**（自动编号 v1、v2……）。发布即快照，之后再改草稿不影响该版本；已被场次选用的版本永久保留。
5. **③ 场次与开场**：选定一个版本并“开场”，系统生成 **6 位入场码**，把入场码连同岗位口令发给对应人员。可点“📡 监视现场”实时查看各岗位确认与服务端事件顺序。
6. **⑤ 设置**：修改导演口令。

### 岗位（`/show.html`）

1. 输入场次**入场码** → 选择本岗位 → 输入**专属口令**进入当场。
2. 页面按顺序显示提示项，仅可对**分配给本岗位**的项目点“确认”。
3. 断线重连或刷新页面后，以**服务端记录**为准自动重绘；多端同时打开也实时同步。

### 规则（服务端强制，非仅前端限制）

- 同一提示项必须其**全部指定岗位**都确认后才标记完成；
- **前一项未全部完成，不能确认后一项**（顺序互锁）；
- 重复提交**幂等**，只保留一次确认记录；
- **提交版本与场次不符、口令错误、确认未分配给本岗位的提示项、越序确认、演出已结束**等情况一律明确拒绝（HTTP 401/403/404/409 + 中文错误信息），**不写入任何记录**；
- 每场演出的事件（开场、确认、单项完成、整场完成）由服务端按场内顺序统一编号；
- 开场后对草稿的编辑、新版本发布、岗位改名均**不影响**已开场演出（版本保存岗位名称快照）。

---

## 五、HTTP / WebSocket 接口摘要

鉴权：登录后返回随机令牌，后续请求带 `Authorization: Bearer <token>`。

**岗位端 `/api/station`**

- `POST /entry` `{ code }` — 凭入场码查询当场与岗位列表
- `POST /login` `{ code, positionId, password }` — 岗位口令登录
- `GET  /state` — 查询当场服务端权威状态
- `POST /confirm` `{ cueId, versionId }` — 确认提示项（顺序/权限/版本校验，幂等）
- `POST /logout`

**导演端 `/api/director`**

- `POST /login` `{ password }` · `POST /logout` · `POST /change-password`
- `GET/POST /positions`、`PATCH /positions/:id`
- `GET /draft`、`POST /draft/cues`、`PATCH/DELETE /draft/cues/:id`、`POST /draft/reorder`
- `GET/POST /versions`（发布不可变快照）
- `GET/POST /shows`（开场）、`GET /shows/:id/state`、`POST /shows/:id/monitor`

**WebSocket**：`/ws?token=<令牌>`。连接成功即推送 `{type:"state",state}`，之后每次确认向该场所有连接广播；客户端可发送 `{"type":"sync"}` 主动重同步。无效/过期会话以 close code `4401` 拒绝，客户端自动退避重连。

---

## 六、目录结构

```
.
├── Dockerfile              # 多阶段构建（原生模块编译 + 精简运行镜像）
├── docker-compose.yml      # 一键启动：构建、端口、卷、健康检查、环境变量
├── package.json
├── tsconfig.json
├── src/                    # 后端 TypeScript
│   ├── server.ts           # Express + HTTP + WS 启动入口
│   ├── config.ts           # 环境变量配置
│   ├── db.ts               # SQLite 连接、建表初始化
│   ├── auth.ts             # scrypt 口令哈希、令牌/入场码生成
│   ├── state.ts            # 当场状态构建 + 确认事务（互锁/幂等/完成）
│   ├── realtime.ts         # WebSocket 鉴权、心跳、广播
│   ├── http-helpers.ts     # 会话鉴权中间件、错误类型
│   ├── routes-director.ts  # 导演端 API
│   └── routes-station.ts   # 岗位端 API
└── public/                 # 前端（原生，无构建）
    ├── index.html
    ├── director.html / director.js
    ├── show.html / show.js
    ├── app.js
    └── styles.css
```

## 七、数据备份与重置

- 备份：复制 `DB_PATH` 指向的 `cues.db`（建议连同 `cues.db-wal`、`cues.db-shm`，或在停服后备份）。
- 完全重置：删除数据文件后重启即自动重建；Docker 下使用 `docker compose down -v`。
