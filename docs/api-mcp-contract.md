# 公益资源服务：HTTP／MCP 能力契约

2026-10-23 能力约定。服务端已提供基础管理、来源同步、扫描、任务验证与配置分发；实际实现的请求和路径见 [OpenAPI](openapi.json)，运行及启用条件见[服务端说明](backend.md)。酒馆插件由其负责人接入，本文不规定 Hub 布局。

本轮按[来源接入与数据同步](source-sync.md)补齐 All API Hub、New API 和 SillyTavern 接口；CPA 不接入。浏览器扩展需更新后接收下发，酒馆新版双向接口等待插件联调。

## 统一管理与分发（2026-10-23 已实现）

以下路径相对 `/api/v2`。普通管理接口同时注册同名 `resource_` MCP 能力，凭据明文写入和执行端交付除外。

- `GET /channels/{id}/credentials`、`POST /channels/{id}/credentials/select`：同账号凭据选择，提交 `version,choiceId`。更换 key 创建独立密文，不覆盖其他连接正在引用的凭据。
- `POST /channels/{id}/lifecycle`：`version,action=archive|pause|resume|review|remove,reason,note,recoveryEnabled`。归档原因限六类；恢复人工暂停保留原归档；复查不立即启用；永久移除不可自动恢复。
- `GET /sync/targets`、`PATCH /sync/targets/{id}`：目标为 `newapi,all-api-hub,sillytavern,notion,chrome-bookmarks`，各自启停和版本。
- `POST /sync/targets/{id}/preview`、`POST /sync/targets/{id}/confirm`：确认提交 `previewId,subjectIds`，只接管选中项目；未选存量不写回，资料变化后必须重新预览。已有停用连接仅同步停用，不重写历史模型和兼容配置。
- `GET /sync/jobs?target=&subject=`、`GET /sync/jobs/{id}/diff`、`POST /sync/jobs/{id}/retry`、`POST /sync/jobs/{id}/resolve`：处理任务、非秘密差异和冲突；选择 `choice=target|center`。镜像不接受反向采用。
- `PUT /sync/targets/notion/credential`：提交 `version,key`，密文留在 fn。Notion 仅更新约定字段，按中心标识及唯一网站关联既有条目。
- `GET /connector/jobs`、`POST /connector/receipts`：只接受独立 `connector` 授权，绑定来源和目标；不是原 `ingest` 的额外权限。RP 授权还须绑定 `channelIds`。任务领取含两分钟租约；回执按任务和租约去重。

任务状态 `pending/running/applied/waiting/failed/conflict/superseded` 表示配置同步状态，不是模型验证结论。中心保存先入队；浏览器离线不显示已生效。账号与签到、New API 渠道分别显示同步结果；渠道启停采用网关实际观察或写入回读。来源回流发现托管字段变化时显示冲突，由用户采用目标配置或恢复中心配置。普通查询和 MCP 不返回 key、认证请求头或原生凭据引用。

## WebUI、Hub 和 Agent 共用标准能力

独立 WebUI 通过 HTTP API 完成管理；Hub 按自身布局使用相同 API；Agent 使用 MCP。页面展示、外部调用和自动维护共用业务层，接口返回业务数据与动作结果，不返回页面组件或 HTML。站点归并、权益判断、可用状态和恢复规则均由服务计算。

建议新版 HTTP 使用 `/api/v2`，MCP 使用 `/mcp`。新版命名空间避免改变旧插件 `/api/v1` 的原有响应；服务切换时保留必要的旧入口适配。

HTTP 用 OpenAPI 3.1 描述请求、响应和错误；MCP 工具提供输入及输出 schema，返回结构化业务结果。两者使用同一业务服务、对象 ID 和权限，不维护两份数据。[OpenAPI](https://spec.openapis.org/oas/v3.1.1.html)、[MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) 是协议依据；可供客户端生成代码的完整 schema 在接口实现阶段随代码交付。

WebUI 使用资源服务的用户会话；Hub 沿用已有用户登录，hub-api 通过服务凭据转发授权操作。资源服务校验来源和操作范围，业务动作不以浏览器 Cookie 作为唯一调用方式。MCP 复用 fn 已有服务认证接入方式。浏览器上报和配置下发使用不同的受限凭据；酒馆凭据限其 RP 绑定；网关管理凭据留在 fn。普通查询不返回明文 key。

WebUI 提供可直接打开的站点、模型筛选和运行记录链接，Hub 可跳转具体对象，不必复刻完整管理页。导航链接只定位对象，不携带 key、会话或调用凭据。具体页面路径在前端实现时与 Hub 接入方一起公布。

本轮已实现通用／生图／视频／酒馆四个用途分组、状态列限制标签、六类归档、应用信息查询、New API 分项同步以及真实 WebUI。`PATCH /api/v2/channels/:id` 可修改 `usage`；`GET /api/v2/bookmarks` 返回同一份书签分类，MCP 对应 `resource_bookmark_plan`。酒馆分组不允许导入 New API；禁止测活仍由标签独立控制。独立 ApplicationBinding 编辑仍为后续契约；现有绑定继续保留，酒馆下发需插件接管后执行。

## 接入方共同使用的数据

| 对象 | 关键字段与含义 |
| --- | --- |
| Site | `id, name, websiteUrl, checkinUrl, aliases, sources, pinned, version`；站点统一入口，保留独立签到地址；置顶属于用户管理资料 |
| Account | `id, siteId, name, sourceRefs, balances, checkin, entitlements, version`；余额和签到归账号。`checkinToday` 是服务端计算的当日签到状态（`state, label, tone, detail, basis, reason, method, confirmedAt, businessDate, timezone`），站点接口与概览 `daily.accounts[]` 返回同一结果，各入口不自行推算 |
| Channel | `id, siteId, accountId, capabilities, tags, baseUrl, protocol, models, knownModels, activeModels, credentialStatus, clientRequirements, management, recovery, version`；一份渠道资料可被多个应用使用，凭据不返回明文。`knownModels` 汇总配置、来源观察、目录扫描和验证记录中的模型；`activeModels` 是当前已生效的模型，两者均由服务计算 |
| ApplicationBinding | `id, channelId, application, instanceId, nativeId, modelId, overrides, enabled, order, version`；保存各应用选定模型和连接设置，多个绑定不改变共享模型目录 |
| ModelAvailability | `channelId, modelId, group, capabilityClass, catalog, stationMetrics, verification, recentCalls`；分组、目录、站方统计和自己的实测分开 |
| Entitlement | `id, accountId, kind, balance, unit, expiresAt, resetTimezone, resetRule, checkinThreshold, releaseTimes, windows, evidence`；时间规则未知则为空 |
| Observation | `source, observedAt, value, coverage`；调用统计的覆盖区间和缺口一起返回 |
| Attention | `id, siteId, channelId, kind, title, reason, action, firstSeenAt, lastSeenAt, state`；只列需要处理的事项，动作是预定义业务动作 |
| Operation | `id, kind, target, state, stage, result, reason, startedAt, finishedAt`；扫描、验证、同步的运行过程 |
| CronBinding | `id, taskRef, channelId, modelId, eligibility, scheduleAdjustment, enabled, version`；绑定现有任务，不复制任务正文 |
| CallResult | `source, sourceId, channelId, modelId, occurredAt, outcome, latencyMs, ttftMs, requestId, taskRef, runId`；来源唯一标识用于去重 |

新版取消 `purpose` 的互斥归属，使用能力、标签和应用绑定：

- `capabilities`：已知支持的 `text/image/video` 能力，可多选；实际可用性仍按模型与调用方式验证。
- `tags`：`client_restricted`（客户端限定）、`no_probe`（禁止测活）、`no_code`（禁止代码）、`no_nsfw`（禁止 NSFW）、`code_only`（仅能用于代码）。保存标签来源、依据与更新时间，人工标签不被来源刷新覆盖。
- `clientRequirements`：配合客户端限定，记录明确客户端、协议和请求头要求；不因为测试过某客户端就设置限制。
- `recovery`：最近失败原因与时间、最后／下次检查、等待条件和是否参加恢复。失败渠道与成功渠道使用同一 Channel 对象。
- `capabilityClass`：模型的 `strong/execution/unclassified`，不代替渠道限制。

旧 `rp` 迁移 `no_probe + no_code` 并保留酒馆绑定，旧 `client` 按已有要求迁移 `client_restricted`；`code_only/no_nsfw` 只按明确规则设置。旧数据保留原分类作为迁移来源，现有 API／OpenAPI 的单值字段在实施时适配，不只改文档就移除旧调用入口。新版查询支持 `capability, tag, application, recoveryState`，多标签采用同时满足语义。

不同模型名称的映射只采用已确认映射；不能仅凭相似名称合并模型指标。

状态分开返回：站点可达性、key 状态、模型任务结果、人工管理状态、配置同步状态。`verification` 包含执行方式、时间、任务引用和结果；没有验证结果不填“成功”。

所有可编辑对象携带 `version`。写入提交读取时的版本；发生并发修改时返回当前值和冲突字段，用户或调用方重新选择。时间用带时区的 ISO 8601，规则同时保存 IANA 时区。列表返回 `items, nextCursor`；未知数值用 `null`，单位随数值返回。

渠道与应用绑定分别使用自己的配置 `version`；余额、调用和来源观察刷新不增加这些版本，避免正常同步或切换酒馆模型造成共享配置冲突。

## 日常查询与维护

以下 HTTP 路径均相对 `/api/v2`。工具前缀统一为 `resource_`，括号中的筛选字段同样适用于 MCP。

| 使用动作 | HTTP | MCP | 主要输入／结果 |
| --- | --- | --- | --- |
| 看今日资源 | `GET /overview` | `resource_overview` | 日期、时区；可用资源摘要、当日权益、签到及待办摘要。签到计数由各账号的 `checkinToday` 汇总，无需签到的账号计入 `notNeeded`，不算未确认或失败 |
| 找站点 | `GET /sites` | `resource_list_sites` | `q, capability, tag, application, status, recoveryState, cursor`；按站点聚合，不按来源重复行 |
| 看完整站点 | `GET /sites/{id}` | `resource_get_site` | 账号、渠道、签到入口、规则、最新结果和来源 |
| 找可用模型 | `GET /models` | `resource_list_models` | `q, capabilityClass, capability, tag, application, availability`；模型及对应渠道，每行的 `active` 与渠道 `activeModels` 使用同一规则 |
| 看处理事项 | `GET /attention` | `resource_list_attention` | 原因、相关资源、动作；不混入普通维护日志 |
| 看维护与调用记录 | `GET /history` | `resource_history` | `siteId, channelId, modelId, kind, from, to`；分页记录及采集覆盖说明 |
| 新增站点／账号／渠道 | `POST /sites`、`POST /accounts`、`POST /channels` | `resource_create_site`、`resource_create_account`、`resource_create_channel` | 明确对象关系；创建和保存不触发上游调用 |
| 编辑资料 | `PATCH /sites/{id}`、`PATCH /accounts/{id}`、`PATCH /channels/{id}` | `resource_update_site`、`resource_update_account`、`resource_update_channel` | `version, changes`；仅更新对应字段，返回新版本 |
| 补或更换 key | `PUT /channels/{id}/credential` | 不在普通 MCP 工具中传递明文 key | 受限安全写入，返回凭据状态和受影响绑定；不回显 key |
| 合并／批量整理预览 | `POST /changes/preview` | `resource_preview_changes` | 合并、标签、暂停、归档、排序等具体动作及目标；返回影响和 `previewId` |
| 应用已预览修改 | `POST /changes/{previewId}/apply` | `resource_apply_changes` | `requestId`；目标版本改变则重新预览，不扩大原范围 |
| 查看／修改维护策略 | `GET/PATCH /policies` | `resource_get_policies`、`resource_update_policies` | 适用站点、扫描周期、候选数量、验证任务、消耗上限与提醒偏好 |
| 查看／处理提醒 | `PATCH /attention/{id}` | `resource_update_attention` | 已读、稍后提醒；不把忽略提醒当成问题已解决 |

创建、修改和补 key 只保存资料；自动维护由已启用策略安排。绑定酒馆不自动禁止测试，所有保存动作均不启动上游请求；是否允许主动检查由 `no_probe` 决定。合并和批量改动先预览是为了让用户知道影响哪些账号和连接；普通单条编辑无需多一步确认。

## 长任务返回进度，不占住客户端

| 动作 | HTTP | MCP | 行为 |
| --- | --- | --- | --- |
| 更新来源资料 | `POST /sources/{id}/sync` | `resource_sync_source` | 同步已有来源，不向上游发送推理任务 |
| 发起模型扫描 | `POST /scans` | `resource_scan_models` | 指定站点／渠道范围，按 `no_probe` 排除并返回原因；目录与指标采集 |
| 发起任务验证 | `POST /evaluations` | `resource_evaluate` | 指定渠道、模型、任务引用或已配置小任务；遵守标签、客户端要求及策略消耗限制 |
| 应用网关配置 | `POST /channels/{id}/apply` | `resource_apply_channel` | 写入与回读，保留应用前后差异；自动恢复使用同一动作 |
| 处理网关配置差异 | `POST /channels/{id}/resolve` | `resource_resolve_channel` | 提交版本及采用外部配置／恢复中心规则的选择，返回处理结果 |
| 查询运行进度 | `GET /operations/{id}` | `resource_get_operation` | 当前阶段、各目标结果、等待原因、最终生效情况 |
| 查看同步来源 | `GET /sources` | `resource_list_sources` | 最近成功时间、在线与缺口状态 |
| 配置接入来源 | `POST /sources`、`PATCH /sources/{id}` | `resource_create_source`、`resource_update_source` | 来源类型、地址、启停及凭据引用；凭据通过受限配置通道保存，不写入 MCP 文本 |

上述写动作接受 `requestId`。客户端响应丢失后使用同一请求标识获取原操作，不重复发起耗额任务。运行记录状态为 `queued/running/waiting/succeeded/failed/cancelled`；`waiting` 必须说明等待的投放窗口、任务执行或外部依赖。

例如，以下仅演示参数格式，标识不指向真实渠道：

```json
{
  "requestId": "example-evaluation-1",
  "channelId": "example-channel",
  "modelId": "example-model",
  "taskRef": { "source": "fn-cron", "id": "example-task" }
}
```

HTTP 接受后返回 `202` 和 `{ "operationId": "example-operation", "state": "queued" }`；MCP 返回同一业务对象。`succeeded` 表示该操作完成，不统一代替模型质量评价；最终结果中分别给出任务通过、模型评价和配置应用结果。

## cron、配置和 RP 对接

| 能力 | HTTP | MCP／调用方 |
| --- | --- | --- |
| 列出可绑定任务 | `GET /cron/tasks` | `resource_list_tasks`；返回任务来源 ID、暂停状态、模型参数能力及结果采集能力 |
| 管理资源绑定 | `GET/POST /cron/bindings`、`PATCH /cron/bindings/{id}` | `resource_list_bindings`、`resource_create_binding`、`resource_update_binding` |
| 接收任务结果 | `POST /ingest/task-results` | 仅受信任的任务适配器调用 |
| 生成目标配置 | `POST /configurations` | `resource_prepare_configuration`；输入目标和渠道，返回制品引用、适用客户端及同步状态 |
| 获取配置／提交应用回执 | `GET /configurations/{id}`、`POST /configurations/{id}/receipt` | 绑定客户端；密钥配置不进入通用查询或 MCP 文本结果 |
| 查询 RP 连接 | `GET /rp/connections` | `resource_list_rp_connections`；返回酒馆应用绑定及关联渠道，过滤实例，读取不访问上游。`rp`／`connector` 凭据只能读取本实例的绑定，不能调用其他管理能力 |
| 保存 RP 连接 | `PATCH /rp/connections/{id}` | `resource_update_rp_connection`；更新对应酒馆绑定，所选模型不覆盖共享目录；共享字段按渠道版本更新 |
| 上报酒馆已保存连接 | `POST /rp/saves` | 酒馆保存适配器；本地版本、中心基线版本和来源事件标识 |
| 取得／确认酒馆配置变更 | `GET /connector/jobs`、`POST /connector/receipts` | 配对酒馆实例及用户；租约任务，确认原生保存回读结果 |
| 接收真实 RP 调用 | `POST /ingest/rp-calls` | 酒馆被动采集适配器 |
| 接收账号、签到及网关观察 | `POST /ingest/events` | 已登记来源适配器；按来源与事件标识去重 |

MCP 提供管理动作，不提供任意 shell、任意 URL 请求或凭据导出工具。确需专用客户端配置时由绑定客户端获取；WebUI 和 Hub 能查看生成、下发、应用和验证的区别。

## All API Hub 上报入口

以下入口使用绑定 `sourceId` 的 `ingest` 凭据，不开放普通管理查询权限。WebUI 的接入设置可生成仅上报的私密配置文件。

| 路径 | 载荷与确认 |
| --- | --- |
| `POST /api/v2/ingest/inventory` | `eventId, occurredAt, deviceId, accounts, removedAccountIds`；账号包含站点／签到地址、原生 ID、观察时间、余额与单位、启停和签到设置；返回同一 `eventId` 及新增／更新数量 |
| `POST /api/v2/ingest/credentials` | `eventId, occurredAt, accountId, complete, credentials, error?`；key 条目包含原生 ID、地址、协议、已有明文 key 或不可取得状态、模型限制及请求头；返回同一 `eventId` 和已保存的来源 key ID |
| `POST /api/v2/ingest/events` | 原账号／签到事件批次，返回 `acknowledgedIds`；旧 `/api/v1/ingest` 保持兼容 |

事件标识按来源去重，旧观察不覆盖新余额。`balance:null` 表示未观察；凭据列表读取失败或只读到掩码，不清空已保存 key。`complete:true` 只表示已读完来源 key 清单，不代表模型调用成功。明文 key 和请求头只进入加密凭据存储，不进入普通 HTTP／MCP 查询。来源页返回 `hubSync` 的账号、余额、key、待读取和读取失败数量及最近接收时间。

账号查询的 `hubKeys` 保留每把来源 key 的名称、协议、模型限制、观察时间和 `credentialStatus`；明文 key 与凭据引用仍不返回。多把 key 不重复创建渠道，也不替换已有人工选定 key。只有账号资料、尚未配置调用连接的站点返回空 `channels`，界面显示“仅账号资料”；已移除渠道不会因此重新进入站点清单。

## 事件和失败语义

新事件公共字段为 `source, eventId, kind, occurredAt, subjectRef, payload`。来源标识由认证身份校验；服务逐条返回已保存、重复或拒绝及原因。确认保存后生产者才从本地队列移除。

业务载荷要点：

- 账号观察：来源账号 ID、站点与签到地址、余额单位和观察时间。
- 签到：账号、业务日期、时区、执行方式、结果、原因及已确认奖励；未确认奖励为空。结果 `无需签到` 与余额门槛、站点暂不允许签到、无可用签到方式等原因表示当日无需签到，不计入失败或连续失败归档。
- 调用／任务结果：任务与运行 ID、实际渠道模型、请求关联、终态、错误分类及耗时；任务质量结论与执行成功分开。不发送提示词或完整输出。
- RP 保存：实例、原生连接 ID、中心连接 ID（首次可缺）、中心基线版本、本地保存版本、变更字段；敏感凭据经受限配置通道传递。

HTTP 的参数错误、认证失败、权限不足、对象不存在、版本冲突分别使用 `400/401/403/404/409`；服务内部错误返回 `5xx`。错误体为 `code, message, details`，必要时附 `operationId`。版本冲突详情包含新版本和可安全展示的字段差异，凭据差异只表示“已更换”。

当前实现：版本冲突统一返回 `code: version_conflict` 和 `details.currentVersion`（酒馆连接另附 `channelVersion`），尚未附字段差异；客户端据此重新读取后再修改。其他 409 是业务规则拒绝，沿用各自的 `code`（如 `scope_changed`、`cursor_expired`）和说明，不应当作版本冲突自动重读。参数错误的 `message` 逐项列出“字段路径：原因”。

某站点的 429、余额不足或模型失败属于扫描／验证结果，不冒充资源服务本身的 HTTP 故障。MCP 业务失败用 `isError` 和同一错误结构；正常返回“渠道验证未通过”的任务结果保留完整业务状态。[MCP 工具结果与错误处理](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

## 分期接入和兼容

第一阶段交付日常查询维护、来源事件、基础 MCP 和使用这些 API 的独立 WebUI，同时提供 RP／cron 的字段契约；未实现动作明确标记能力未就绪。第二阶段接入长任务和 cron 验证，并在 WebUI 展示配置及进度；第三阶段完成酒馆及专用客户端联调和冲突处理入口。接口随对应能力交付，不等 WebUI 全部完成后再补开放接口。

旧版已在使用的 `/api/v1/ingest`、`/api/v1/rp/connections`、`/api/v1/rp/:id/config`、`/api/v1/rp/:id/saved`、`/api/v1/rp/calls` 按原请求、响应、权限和去重方式承接。切换前核对实际消费者；不能只保留相同 URL 却改变数据含义。

接口就绪后由服务提供方交付 OpenAPI 文件、MCP 工具清单、无密钥示例数据和联调地址。

## 扫描、任务验证与自动恢复

`GET /api/v2/maintenance` 返回维护策略、当天验证次数、逐渠道等待原因、下次扫描时间和维护操作记录。MCP 使用 `resource_maintenance_status` 读取同一结果。

`POST /api/v2/maintenance/runs`（`resource_maintain_channels`）接收 `requestId`、可选 `channelIds`／`siteIds`，完成目录扫描后安排候选任务。返回的是操作，不把“扫描完成”算成“模型验证通过”；后续验证和网关应用各有操作记录。

- `/scans` 仍只读网站、目录和站方指标，不隐式启动任务。
- `/policies` 增加 `modelRules`（名称包含匹配、强模型／执行模型候选）、`excludedModels`、`maxEvaluationsPerDay`。每渠道每轮最多 `maxCandidates`，同一份扫描不重复派发。
- 已绑定且已适配的 cron 优先，沿用原调度。`/cron/runs/prepare` 为一次运行锁定候选；重复 prepare 复用身份，另一个运行不会领走同一项评估。`acceptance=passed` 且渠道、模型和连接版本一致才允许恢复。
- 小任务须启用 `smokeEnabled`。通过 New API 的固定渠道身份执行，有代码审查／非代码计算两种任务；验证后撤销临时调用身份。只保存验收、耗时和错误，不保存生成正文。
- `autoApply` 开启且实例允许写入时，任务通过后应用该模型，回读一致才更新恢复状态。临时验证模型使用随机别名；未通过的新验证连接在网关停用，不进入正常模型池。
- 手动模型验证使用 `/evaluations`；网关冲突沿用 `/channels/:id/resolve`，可采用外部值或明确恢复中心规则。

禁止测活、已移除、人工暂停与禁止使用都不参加主动检查；同一凭据的别名不能绕过禁测。酒馆不导入 New API，生图／视频不执行文字验证。客户端限定连接等待符合要求的真实客户端任务。
