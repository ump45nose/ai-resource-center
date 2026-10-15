# 多客户端配置、原生同步与 fn 网关

推荐保持现有 fn 网关，用 Magpie 原生能力配置客户端和同步连接库；客户端限定渠道优先验证 New API 的原生协议透传。无需为“保留客户端标识”新增 Hub，也无需开发上一版提出的中心配置源和设备回执服务。

管理中心继续聚合资源、签到、权益和调用情况。客户端长期使用稳定入口，上游调整在 fn 完成；RP 继续直连酒馆。

## 复核结论

2026-10-15 读取 Magpie 0.1.1244 的 Docker、Remote Magpie、原生同步、自动组及请求转发源码。fn 当前 New API 为 v1.0.0-rc.44；使用其实际部署镜像在临时独立容器验证了请求透传。生产渠道、客户端和原生同步设置均未修改。

| 方案                     | 已有能力                                                                     | 适用范围与代价                                                      |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Magpie 原生 WebDAV       | 供应商、key、组、预设、Agent 模型与 Library 跨设备同步                       | 各机保存连接库并自行使用；现成可用，无需新增中心配置源              |
| fn 上的无头 Magpie       | 集中供应商、账号、路由组、网关密钥、调用和额度；可用 Web UI 管理             | 需要统一 Magpie 的多账号/订阅和路由能力时合适；新增一个实际推理网关 |
| Remote Magpie            | 本机只保存远程入口和自己的调用密钥，使用远端模型与路由组；本机继续配置 Agent | 已有完整远程网关能力，不必复制上游配置到所有设备                    |
| 现有 New API 原生透传    | 同协议请求体和客户端请求头透传，同时保留现有渠道、调用身份和日志             | 当前首选；自有 stub 验证通过，真实公益站按对应客户端逐个确认        |
| 现有 Nginx Proxy Manager | 固定上游反向代理，保留 HTTP 请求特征和流式输出                               | 少数需要更原样 HTTP 转发的连接；复用 fn 已有服务，无需新增 Hub      |

上一版把“完整设备配置控制”作为实现前提，扩大了当前的同步需求。现成 Remote Magpie 和原生同步已覆盖主要使用方式，撤销新增配置源、托管缓存、设备发布与回执接口的首选方案。

## Magpie Linux Hub 能否在 fn 统一管理

可以。Linux/Docker 中 `magpie serve` 运行无头网关；需要管理页时可用 `magpie web --no-open`。无头服务不需要桌面或常驻浏览器。普通 API key 供应商不需要为了它启动订阅插件。

两种现成接法：

- 应用直接指向 fn Magpie，Anthropic 使用根地址，OpenAI/Responses 使用 `/v1`，模型使用远端供应商或组的标识。
- 本机 Magpie 添加 `remote-magpie` 供应商，由它继续配置本机 Agent；供应商、上游 key、订阅和路由组留在 fn。

Hub 可为设备分别签发网关密钥，限制可用模型和额度，并按调用密钥记录用量。本机收到的是允许使用的模型目录。一个稳定组的成员在 fn 调整后，客户端继续请求同一个组；新增模型通过原生目录刷新发现。

因此，选择 Hub 时也不需要自建配置下发服务。它的实际代价是增加或迁移一个推理网关，以及相应路由、日志和管理维护。目前 New API/CPA 已在 fn 承担网关，只为保留客户端 HTTP 特征再加一层 Magpie，收益不足。

本轮保留现有网关；Magpie Hub 是集中使用其订阅与路由能力的可行替代方案，不作为所有客户端接入的前提。

## 客户端限定渠道的轻量入口

首选路径：**原客户端 → fn New API 的对应原生协议渠道 → 上游**。使用本机 Magpie 的应用仍可由它选择该入口。Code 归属和原客户端限制继续保留，不能并入通用候选池。

New API v1.0.0-rc.44 的渠道配置可用：

| 渠道字段                     | 内容                                 | 作用                                                                       |
| ---------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| 请求体设置 `setting`         | `{"pass_through_body_enabled":true}` | 读取原始正文，避免重新序列化丢失客户端特有字段                             |
| 请求头覆盖 `header_override` | `{"*":true}`                         | 透传客户端请求头，原生排除认证、Cookie 和逐跳头；上游认证仍由渠道 key 生成 |

表中是字段的 JSON 内容；调用管理 API 时这两个字段按原接口保存为 JSON 字符串。也支持 `{client_header:User-Agent}` 这类动态取值，不需要伪造一个固定客户端版本。

隔离实测结果：

| 请求                   | 默认转发                 | 开启透传                                                          |
| ---------------------- | ------------------------ | ----------------------------------------------------------------- |
| Anthropic 正文         | 被重新编码，未知字段丢失 | 字节一致，未知字段保留                                            |
| Claude Code 特征头     | 部分保留，部分丢失       | 合成请求的 User-Agent、x-app、Anthropic、Stainless 和会话头均保留 |
| Anthropic SSE          | 本轮只验证透传配置       | 正常返回结束事件                                                  |
| Responses 正文和特征头 | 本轮只验证透传配置       | 字节一致；User-Agent、originator 和 session_id 保留               |
| 上游认证               | 使用渠道 key             | 继续使用渠道 key，没有将下游调用凭据转给上游                      |

共 4 次自有 stub 请求，测试容器与独立数据卷均已删除。[脱敏回执](../verification/newapi-passthrough.json)；[复核脚本](../../scripts/review-newapi-passthrough.py)。这里使用合成客户端特征请求，没有请求公益站或把所有渠道重新跑一遍 Claude Code。

透传渠道使用上游真实模型名和相同协议；需要原始正文时不依赖模型改名、协议转换或提示词注入。New API 仍会解析请求做选路、计额，不能把它理解成任意 HTTP 路径和查询参数的透明隧道。

接入客户端限定渠道时还需核对自动测试：`auto_ban=0` 只在自动任务采用 `auto_ban_only` 模式时会使该渠道被排除；其他模式仍可能测试它。不能用“不自动禁用”冒充“不主动测试”，也不为新增连接默认改掉整个网关的测试规则。

若该站需要 New API 尚未保留的 HTTP 特征，或不能从当前主动测试中排除，则用现有 Nginx Proxy Manager 为它建立固定入口：保留实际请求的头、正文和查询参数，只替换必要的上游认证与 Host，关闭响应缓冲以支持 SSE。该入口固定对应上游，不另做一套轮询或模型转换。原协议验证成功后再记录可用。

HTTP 代理保留的是 HTTP 请求特征；上游看到的出口 IP 和 TLS 连接来自 fn。客户端限制依赖哪些特征，最终以原客户端经该入口的真实任务结果确认。

## 原生同步如何配置

各设备已安装 Magpie 时，继续使用原生 WebDAV 同步，不新增常驻同步代理。

- 共享连接库、组和需要共享的 Library。普通资源主要存放 fn 网关入口，不把所有公益站上游 key 下发到每台设备。
- 设备需要各选各的模型时设 `agents=no`，由本机 Magpie 继续选择；只有确实希望同步当前 Agent 模型时才开启。当前本机仍是 `agents=true`，本轮未替用户切换。
- 在一个主要入口维护共享供应商。原生同步默认三分钟，双方同时改同一分区时取较新分区并保留替换副本，不是逐供应商合并。
- 不同应用使用不同 fn 推理身份，例如 Claude Code、Codex、Hermes Chat、Hermes Cron。需要分别维护时，原生供应商保存各应用对应的固定入口和身份。
- 需要设备独立身份时可使用原生 `keys=no` 保留本机 key；设备首次填入自己的推理身份即可。使用 Remote Magpie 时，直接复用 Hub 的设备网关密钥及模型限制。

初次接入和原生整套恢复都先查看影响，不把恢复操作当作增量导入。官方订阅登录继续在对应实例登录，原生备份不携带登录。

原生同步状态说明连接库是否同步；客户端是否使用新配置，以其原生配置读取和具体设备的真实调用为依据。中心保留配置生成、人工验证和调用来源时间，不新增一个没有实际依据的“所有设备已生效”标记。

## Magpie 自动聚合和轮询的边界

你看到的自动聚合存在：多个供应商提供同名模型时，Magpie 可以生成一个自动组；跨不同名称的模型需要明确建组或配置命名关系。

| 策略          | 行为                                   |
| ------------- | -------------------------------------- |
| smart（默认） | 根据可读到的额度、重置与使用信息选路   |
| order         | 优先使用前面的候选，不可用时再尝试后面 |
| rotate        | 轮转候选                               |
| weight        | 平滑加权分配                           |
| usage / pace  | 按使用情况或剩余额度节奏选路           |

实际分配还受会话亲和、并发、限流休息及失败切换影响。自动发现同名模型，不等于每次请求严格轮询。Magpie 已有请求运行时的选路与失败处理，不必为它另写一套。

中心的七天样本、成功率门槛、人工评价、公益站签到门槛和当日额度期限仍由中心维护。Magpie 的 smart 不自动等于这套质量评分，未知的公益站权益也不会仅因模型同名而被识别。

保持一次请求链中只有一个资源池负责选路：普通渠道由 fn New API/CPA 管；本机 Magpie 使用固定 fn 入口，不再把相同上游直连和 fn 入口混成第二个池。客户端限定池按适用客户端和协议维护；RP 不参加自动组。

指定渠道评估时使用已准备的固定渠道配置；选择 Magpie 时使用明确的 `provider/model` 或已固定的手动组，并确认无额外 fallback，不能选自动组冒充指定渠道。

## 客户端标识的纠正

上次只根据 `passUserAgent` 字段解释默认行为不完整。Magpie 对 Claude Code 的 Anthropic 转发已有专门的头和正文保留逻辑；Remote Magpie 的会话转发也保留 Claude Code/Codex 特征，包括 Codex 的 originator。`passUserAgent` 是额外的通用透传选项，不是所有原生兼容路径的唯一开关。

因此使用 Magpie 本机或 Hub 都是现成方案，真实验证仍从受限渠道指定的客户端发起。现有中心 Magpie 导出的 `baseAPI` 枚举、Anthropic 根地址和认证映射仍需修正；这属于导出适配，不需要新增同步系统。

## 界面和开发范围

设置保留原生同步入口与来源状态；连接详情显示 fn 入口、用途、所需客户端、协议、最后验证设备/时间和错误。导出注明配置目标及实际验证情况。RP 面板沿用现有保存、冲突和手动应用。

取消上一版新增的中心配置源、设备领取凭据、托管缓存、专用发布/回执接口和设备强制跟随模式。后续开发集中在现有导出映射、明确的原生透传字段及来源状态展示，不修改 Magpie 内核，也不增加一套客户端配置写入器。

## 依据

- [Magpie Docker/无头部署](https://github.com/yetone/magpie/blob/v0.1.1244/site/public/docs/zh/docker.html)
- [Remote Magpie 官方接入说明](https://github.com/yetone/magpie/blob/v0.1.1244/site/public/docs/zh/remote.html)
- [原生同步范围与冲突](https://github.com/yetone/magpie/blob/v0.1.1244/docs/subsystems/sync-backup.md)
- [自动组与路由](https://github.com/yetone/magpie/blob/v0.1.1244/internal/provider/group.go)
- [网关选路与远程客户端特征](https://github.com/yetone/magpie/blob/v0.1.1244/docs/subsystems/gateway-routing.md)
- [Claude Code 原生转发验证](https://github.com/yetone/magpie/blob/v0.1.1244/internal/gateway/claude_code_headers_test.go)
- [New API 请求头透传](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.44/relay/channel/api_request.go)
- [New API Anthropic 正文透传](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.44/relay/claude_handler.go)
- [New API Responses 正文透传](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.44/relay/responses_request.go)
- [New API 自动测试筛选](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.44/controller/channel-test.go)
- [Nginx 请求头、正文与缓冲配置](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
