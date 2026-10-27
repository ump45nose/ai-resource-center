# 公益资源管理服务

新版服务端提供来源接入与同步、渠道模型扫描、cron 验证、New API 应用，以及共用业务层的 HTTP API／MCP。独立 WebUI 已接真实资料、渠道标签和 New API 同步；All API Hub 已接入账号、余额、签到和 key 持续上报，后续接入酒馆的新上报，不恢复旧版页面。

## 打开真实资源管理界面

新版入口：[AI Resource Hub](http://192.168.31.201:18323/)。沿用原管理密码。渠道标签、历史失败资料和 New API 同步已经接入；All API Hub 持续同步已接入，酒馆新版适配后续接入，CPA 不接入本版。

本机开发：

```sh
npm ci
npm run dev
```

[本机页面](http://127.0.0.1:18322/)默认通过 Vite 代理读取 fn API，不再使用示例数据。`ARC_API_TARGET` 可指定其他 API 地址。

`npm run build` 类型检查并生成 `dist/`；`npm start` 同源提供页面和 API。[前端结构](docs/frontend.md)

## 扫描与自动恢复

在“扫描与测试”选择渠道，使用“只扫描目录”或“扫描并验证”。维护设置统一配置周期、认可型号与次数上限；模型详情分别展示个人 key 目录、站方指标、任务验收及 New API 生效结果。

fn 已开启允许检查渠道的网站、key 目录和模型广场定期复查；自动任务与恢复暂未开启。真实 cron 尚待执行入口适配，生图／视频生成验证等待 image-caption。禁止测活不发请求，酒馆不导入 New API。已接管连接的日常编辑自动同步，与归档恢复开关分开。

## 运行服务端

```sh
npm ci
DATA_DIR=./data PORT=18323 npm start
```

需要 Node.js 24 或以上。新数据目录的首次登录密码写入该目录的 `admin-password`；已有数据库沿用原密码、凭据和 `master.key`，不重置。不要把数据目录或接入文件提交到 Git。

- `GET /api/health`：版本、维护执行器与网关写入开关。
- `GET /openapi.json`：可直接供前端使用的接口定义。
- `/api/v2`：管理接口；`/mcp`：Streamable HTTP MCP。
- [服务端使用与验收](docs/backend.md)：部署位置、鉴权、来源和 cron 接入方式。
- [OpenAPI 文件](docs/openapi.json)：由 `npm run openapi` 从同一套能力定义生成。

来源自动同步由各 New API 的 `syncEnabled` 单独控制，不依赖自动维护。默认不启用扫描与任务维护；网关写入还需显式设置 `GATEWAY_WRITES=true`。并行数据副本不得与旧版同时托管同一网关。查询、手动来源同步和目录扫描不依赖网关写入开关。

## 本轮已确认的方案

提供独立 WebUI、fn 上的业务服务、标准 HTTP API 和 MCP。WebUI 是完整管理入口；Hub 按自身布局接入同一套能力，由 Hub agent 负责；酒馆侧由酒馆 agent 实现，本项目提供对接方案。

- [产品需求与开发阶段](docs/requirements.md)：产品形态、WebUI 使用流程、能力归属、自动维护和三阶段交付。
- [来源接入与数据同步](docs/source-sync.md)：All API Hub、New API 和酒馆的接入方式、字段归属、同步节奏与本轮实施顺序。
- [HTTP／MCP 能力契约](docs/api-mcp-contract.md)：数据、动作、事件和兼容方案；实际已实现路径以 OpenAPI 为准。
- [外部对接说明](docs/integration-handoff.md)：可直接交给 Hub、酒馆及 cron 接入方。

## 数据和旧网站继续保留

- 旧网站：[AI 资源中心](http://192.168.31.201:18321/)，仍由 fn 上原容器运行。
- 新版数据：fn 的 `/vol2/1000/Docker/ai-resource-center-v2/data`，已从旧库最新一致快照迁入全部现有记录，沿用稳定 ID 和配套密钥。
- 旧版数据：fn 的 `/vol2/1000/Docker/ai-resource-center/data`，旧网站和原插件入口继续运行；其后续人工修改暂不自动回写新版。
- fn 旧运行源码仍在 `/vol1/1000/Code/.worktree/ai-resource-center/ai-resource-center`，作为旧版维护副本，不是新版开发目录。

## 旧代码在哪里

[本机备份与恢复说明](/Users/sm5145/Documents/Codex/2026-10-21/ai-resource-center-before-refactor-111818/README.md)

备份包含本机和 fn 的源码、Git 历史、未提交及未跟踪文件、数据库一致快照、持久文件、配套密钥和运行镜像。本机另有一份可直接阅读的旧工作区：

`/Users/sm5145/Documents/Codex/2026-10-21/ai-resource-center-before-refactor-111818/legacy/ai-resource-center`

fn 也保留独立备份：`/vol2/1000/Docker/ai-resource-center/backups/20261021-111818-before-refactor`。这些备份含私密信息，不放入 Git。

## 重构时用什么

- [现有数据说明](docs/data-contract.md)：保留哪些数据、关联和状态含义。
- [可复用逻辑索引](docs/reuse-map.md)：从旧代码抽取业务与集成逻辑，不沿用旧界面和大类结构。

新版使用独立数据副本并行运行。正式切换前从仍在运行的旧版获取最新数据，不用备份快照覆盖后续修改。
