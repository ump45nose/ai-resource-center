# AnyRouter / AgentRouter：真实 Claude Code 经 New API 的对照

2026-10-15 北京时间 11:45–11:50，使用 Claude Code 2.1.299、fn 当前 New API v1.0.0-rc.44 镜像。**真实 CLI 的正文和客户端特征头经 New API 保持一致；两站成功生成均被当时的上游资源状态阻塞。**

| 站点                                   | 模型与条件                             | 同 fn 出口直连                | 经 New API | 特征比较           |
| -------------------------------------- | -------------------------------------- | ----------------------------- | ---------- | ------------------ |
| [AnyRouter](https://anyrouter.top)     | Sonnet 4.5，普通模型配置               | 400，要求启用 1M              | 相同 400   | 正文与客户端头一致 |
| [AnyRouter](https://anyrouter.top)     | Sonnet 4.5，原生 `[1m]`                | 429 Service Unavailable       | 相同 429   | 正文与客户端头一致 |
| [AnyRouter](https://anyrouter.top)     | Opus 5.5，原生 `[1m]`                  | 400，站点提示 Claude 供应不足 | 相同 400   | 正文与客户端头一致 |
| [AnyRouter](https://anyrouter.top)     | 站点提示的 `gpt-6-astra-cc-format[1m]` | 429 Service Unavailable       | 相同 429   | 正文与客户端头一致 |
| [AgentRouter](https://agentrouter.org) | `claude-opus-5`                        | 402，资源池额度耗尽           | 相同 402   | 正文与客户端头一致 |

模型名称按请求及站点提示记录，不把供应商标签解释为底层模型身份鉴定。

## 比较方式

真实 CLI 使用临时配置、短任务、无工具和独立目录。直连与网关请求均从 fn 出站。自有观测点记录 CLI 进入网关前和 New API 发出后的请求，再转发到对应公网 API；正文只在内存比较，不进入报告。

各组使用同一站点 key、同一选定模型、同一出口。每组只发起一次公网推理；CLI 的后续重试复用已经观察到的错误响应，收到资源错误后结束客户端重试。共 10 次公网推理请求。

New API 渠道为 Anthropic 原生协议，配置 `pass_through_body_enabled=true`、`header_override={"*":true,"Authorization":"Bearer {api_key}"}`，使用固定渠道单次尝试的推理身份。

网关前后原始正文逐字节一致；User-Agent、x-app、Anthropic beta/version、Stainless、Claude Code 会话等客户端请求头全部保留。认证由网关替换；经网关时除 Bearer 外增加原生 x-api-key，不将这项认证变化算作客户端特征变化。Host、Cookie、长度和逐跳头也不属于本次特征相等比较。

## 可用性结论

- 两站均已用真实 CLI 验证 New API 的请求特征保留行为。
- AnyRouter 启用 1M 后仍受 429 阻塞；更换其当前提示的 Messages 模型后也返回 429。
- AgentRouter 的直连和网关均是资源池耗尽。本轮没有成功生成的基线，站点完成生成及全部客户端校验的接纳仍待资源恢复后验证。

隔离容器、数据卷、测试凭据文件及客户端临时目录已清理。生产网关渠道、原客户端默认配置和站点归属没有修改。

[脱敏逐次回执](router-client-features.json)
