# AI Resource Center · 公益资源中心

集中查看和管理公益 API 站点的账号、余额、签到、模型与渠道状态。中心保存整理结论，通过 All API Hub、New API 和酒馆适配器同步配置及执行结果，提供独立 WebUI、HTTP API 和 MCP。

## 主要能力

- 按站点聚合账号和连接；通用、生图、视频、酒馆分组独立管理。
- 编辑地址、key、模型、限制标签、权益规则、启停和归档；凭据加密存储。
- All API Hub 回传账号、余额、签到和调用 key；New API 同步配置与真实调用。
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

`node scripts/bench-overview.mjs` 在 `/tmp` 生成生产量级数据，为概览、来源、站点、模型、签到和待处理接口计时；`--export` 以固定时钟导出响应，`--compare` 逐字节比较两个版本（`--help` 查看参数）。

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

禁止测活、人工暂停、固定和永久移除的渠道遵守各自限制。网站失败与 API 失败分别记录；能拉模型不等于任务验证通过。归档恢复只开放通过验证的模型；酒馆连接不导入 New API。

任务验证与自动恢复沿用试点门槛；生图／视频生成验证等待 image-caption。当前开关、等待原因与目标生效状态以“扫描与测试”和 `GET /api/v2/maintenance` 为准。

## 接口与集成

Personal Hub 的只读接入复用 `read` 凭据和已有概览、站点、来源、待处理事项接口。
`GET /api/v2/overview` 新增 `daily`：今日按受益账号去重的签到摘要、独立账号权益、
登记渠道／目录可读渠道／已有任务验证通过的渠道模型组合数量，以及观察时间和覆盖说明。
原概览字段保持兼容。权益的新增 `availability` 为 `available/unavailable/unknown`；
旧余额失去时效时为 unknown，原 `available` 字段保留。
签到摘要的 `expected` 是自动签到配置与当日实际观察账号的并集，
`automaticExpected` 单列自动签到账号数；当日人工签到也计入成果，汇总分母保持一致。

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
