# 从旧代码抽什么

旧代码位于：

`/Users/sm5145/Documents/Codex/2026-10-21/ai-resource-center-before-refactor-111818/legacy/ai-resource-center`

下表路径均相对于这个旧工作区。它们是抽取入口，不是新版模块划分。

| 能力 | 旧代码入口 | 值得保留的部分 |
| --- | --- | --- |
| 数据与凭据 | `server/store.mjs` | 现有表读取、稳定标识、事务和加密凭据解密 |
| 账号与签到接收 | `server/center.mjs` 的 `account`、`ingest` | 来源关联、旧观察不覆盖新观察、事件去重和保存后确认 |
| 表格与来源导入 | `server/imports.mjs`；`center.mjs` 的导入方法 | Excel/JSON 解析、来源关联、人工确认合并、签到入口和历史说明 |
| 真实调用汇总 | `server/gateways.mjs` 的 `call`、`syncCpa`、`syncOnce`；`server/calls.mjs` | New API/CPA 调用采集、去重、来源口径及缺口记录；CPA 使用 Manager 持久结果，不另消费破坏性队列 |
| 网关配置操作 | `server/gateways.mjs` 的 `applyOnce`、`adopt`、`inferenceToken` | 写入后回读、外部配置冲突、固定渠道评估身份；保留客户端特征的原生透传设置 |
| 模型目录扫描 | `server/model-scan*.mjs`；`scripts/scan-models*.mjs` | 站方指标和个人 key 目录分开、浏览器会话补充；旧 RP 域名排除改成“禁止测活”渠道及其重复连接识别，目录可见不等于实测可用 |
| 权益时间与评价 | `server/domain.mjs` 的 `dayKey`、`nextReset`、`availability`、`evaluate` | 时区重置、可用窗口、样本门槛、非质量错误排除和人工优先规则 |
| RP 被动采集 | `server/rp-calls.mjs`；`.integration/sillytavern-rp/src/host/resource-center-calls.ts` | 真实请求与终态关联、离线重交、历史结果未知、不采集正文、不主动测活 |
| 客户端配置 | `server/exports.mjs`；`server/domain.mjs` 的 `headers` | 协议、认证和请求头的目标格式；配置生成与客户端验证分开 |

导入、关联和状态计算目前耦合在 `Center` 与 `Gateways` 两个大类里。重构按实际流程抽取，不整体搬入。旧 `web`、`prototype`、页面状态拼接、构建产物和联调脚本只留在备份中，不作为新版基础。

## 仍在工作的外部集成

- All API Hub：`/Users/sm5145/WorkSpace/Code/Github/all-api-hub-refresh/.worktree/ai-resource-center/src/services/resourceCenter/`，包括 `outbox.ts` 和 `background.ts`。当前检查点 `aebd4fab1`；队列在中心确认保存后才移除，上报失败不重复签到。
- 酒馆：fn 的 `/vol1/1000/Code/.worktree/ai-resource-center/sillytavern-workbench/src/host/`，包括 `resource-center.ts`、`resource-center-native.ts` 和 `resource-center-calls.ts`。当前检查点 `317731c`；生产扩展仍在 `/vol2/1000/Docker/sillytavern/extensions/ai-resource-center`。

这些独立仓库和生产配置本次未清理。重构时保留已在使用的上报与原生保存逻辑，再替换中心侧实现。
