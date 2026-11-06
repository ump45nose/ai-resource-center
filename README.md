# AI Resource Center · 公益资源中心

集中查看和管理公益 API 站点的账号、余额、签到、模型与渠道状态。中心保存整理结论，通过 All API Hub 和 New API 同步配置及执行结果，提供独立 WebUI、HTTP API 和 MCP。RP（酒馆）渠道不在中心管理，只在酒馆和 Chrome 书签中维护。

## 主要能力

- 按站点聚合账号和连接；通用、生图、视频分组独立管理。
- 编辑地址、key、模型、限制标签、权益规则、启停和归档；凭据加密存储。
- All API Hub 回传账号、余额、签到和调用 key，名称、地址与签到入口以插件为准，中心只回写停止或恢复自动签到；New API 同步配置与真实调用。
- 扫描模型目录和站方状态，通过 cron 或小任务验证，按具体模型恢复连接。
- 六类异常分别归档、定期复查或等待账号／额度变化；禁止测活的渠道只接收被动数据。
- 托管配置下发、回读、重试和冲突处理；Chrome 书签镜像独立同步，Notion 可选。

实际模型请求由 New API 或使用方直连上游；管理中心不经过推理请求路径。CPA 不接入。

## 开发

需要 Node.js 24 或以上。

```sh
npm ci
npm run dev
```

开发页面为 `http://127.0.0.1:18322/`，默认代理到 fn 的 API。用 `ARC_API_TARGET` 指定其他服务地址。

```sh
npm test
npm run build
DATA_DIR=./data PORT=18323 npm start
```

`npm run build` 执行类型检查并生成前端产物；`npm start` 同源提供 WebUI、API 和 MCP。新数据目录的首次登录密码写入 `data/admin-password`；已有数据沿用原密码和配套 `master.key`。

## fn 部署

源码与 Compose：`~/code/ai-resource-center`（`/vol1/1000/Code/ai-resource-center`）。

```sh
cd ~/code/ai-resource-center
docker compose build ai-resource-center-server
docker compose up -d --no-deps ai-resource-center-server
```

- 管理界面：`http://192.168.31.201:18323/`。
- 持久数据：`/vol2/1000/Docker/ai-resource-center-v2/data`，包括数据库、加密密钥和接入授权。
- `browser-image-bridge` 是浏览器生图适配服务，按需单独更新。
- 旧 `app` 部署路径保留兼容链接；Compose 项目名固定为 `app`，沿用现有容器。

数据、会话、凭据、构建产物和备份不纳入 Git。备份数据库时保留配套 `master.key`。

## 同步、扫描和恢复

来源同步、主动扫描、任务验证与自动恢复分别控制。首次接管先预览；接管后，中心日常编辑自动排队分发，来源观察不覆盖人工结论。目标侧修改托管字段时显示冲突，等待选择采用哪一侧。

禁止测活、人工暂停、固定和永久移除的渠道遵守各自限制。网站失败与 API 失败分别记录；能拉模型不等于任务验证通过。归档恢复只开放通过验证的模型。

RP 渠道已由启动迁移一次性移出中心，记录和历史保留；Chrome 书签的“酒馆”目录保持迁移时的内容。撤销方法见[数据含义与迁移约束](docs/data-contract.md#rp-渠道移出中心)。旧酒馆插件调用 `/api/v1/rp/*` 会收到 `410`。

任务验证与自动恢复沿用试点门槛；生图／视频生成验证等待 image-caption。当前开关、等待原因与目标生效状态以“扫描与测试”和 `GET /api/v2/maintenance` 为准。

## 接口与集成

Personal Hub 的只读接入复用 `read` 凭据和已有概览、站点、来源、待处理事项接口。
`GET /api/v2/overview` 新增 `daily`：今日按受益账号去重的签到摘要、独立账号权益、
登记渠道／目录可读渠道／已有任务验证通过的渠道模型组合数量，以及观察时间和覆盖说明。
原概览字段保持兼容。权益的新增 `availability` 为 `available/unavailable/unknown`；
旧余额失去时效时为 unknown，原 `available` 字段保留。
签到摘要的 `expected` 是自动签到配置与当日实际观察账号的并集，
`automaticExpected` 单列自动签到账号数；当日人工签到也计入成果，汇总分母保持一致。

账号当日签到状态只在服务端计算：`daily.accounts[].checkinToday` 与站点接口各账号的
`checkinToday`（含 `checkinAccount`）是同一结果，WebUI 直接展示。`state` 为
`done/not_needed/action_required/failed/pending/not_applicable`，`basis` 标明依据：
签到记录 `event`、站点状态 `site_status`、插件人工标记 `manual_mark`、设置 `settings`、尚无记录 `none`。
每个账号按签到记录的时区取当前业务日（缺省为签到账号的重置时区，再缺省 Asia/Taipei）；
插件随当日签到状态上报站点自己的业务日 `checkin.businessDate`（如中午重置的 Chatflows）时以它为准。
`daily.date` 仍按 Asia/Taipei。`expected = completed + failed + unconfirmed + notNeeded + notObserved`：
站点状态或人工标记显示今日已签到也计入 `completed`，对应 `items` 的 `method` 为“站点状态”或“人工标记”；
余额高于门槛、站点暂不允许签到、无可用签到方式时无需签到，自动签到账号计入新增的 `notNeeded`，
均不列入 `items`、`unconfirmed` 或 `failed`；需登录、需人工操作仍计入 `failed` 并生成 `interventions`。
`items` 另含 `state/basis/label`。

`GET /api/v2/checkins`（MCP `resource_list_checkins`）接受
`start_date,end_date,siteId,cursor,limit`，默认最近 30 个业务日、Asia/Taipei，
分页默认 50、最大 200。返回 `items,nextCursor,coverage`。同账号、同业务日仅一行；
已关联签到账号归到唯一受益账号，保留 `executorAccountId`。
`latestResult` 是最近尝试，`confirmed/confirmedAt` 保留当日已有成功事实，
`rewardText` 保留已确认记录的原文，未知数值 `reward=null`，不推算收益。
游标绑定查询及记录快照，变化时返回 `409 cursor_expired`，需从首页重读。
覆盖范围只表示已接收记录，缺失日期不填零；读取不触发签到、同步或模型调用。

| 入口 | 用途 |
| --- | --- |
| `GET /api/health` | 版本、执行器与网关写入状态 |
| `/api/v2` | 管理 API，使用登录会话或服务凭据 |
| `GET /openapi.json` | 当前服务的 OpenAPI 定义 |
| `POST /mcp` | 带认证的 Streamable HTTP MCP |
| `integrations/nas-cron/` | fn cron 目录、执行与结果回执适配 |
| `integrations/browser-images/` | 浏览器生图会话与 API 桥接 |

`npm run openapi` 从服务能力定义更新 `docs/openapi.json`。

- [服务端与部署](docs/backend.md)
- [前端结构](docs/frontend.md)
- [来源同步](docs/source-sync.md)
- [数据含义与迁移约束](docs/data-contract.md)
- [HTTP／MCP 能力契约](docs/api-mcp-contract.md)
- [外部集成对接](docs/integration-handoff.md)
- [产品设计参考](docs/requirements.md)
