# AI 资源中心

按站点管理自己的公益渠道、账号权益、签到结果与应用连接。实际推理继续使用 New API、CPA 或酒馆直连，中心停机不影响这些入口。

- 管理入口：<http://192.168.31.201:18321>
- [详细设计](docs/design/ai-resource-center.md)
- [多设备与客户端同步设计](docs/design/client-config-sync.md)
- [设计原型](https://www.figma.com/make/HUuM1xwL2LMK6qvoXy5w73/Untitled)
- [部署、验证与使用说明](docs/delivery.md)
- [实施记录](docs/plans/2026-10-14-ai-resource-center.md)

## 日常使用

“今日”看待办、当日额度及来源更新时间。“资源与连接”按站点聚合，展开账号与连接；网站和签到入口直接可点。站点打不开、API 调用问题、缺 key、额度与限流分别保留；无法签到是账号权益说明。

RP 页手工维护、排序和暂停连接，编辑和导入不会请求上游。客户端绑定页通过 New API 的独立客户端/协议分组聚合，保留 Claude Code 等指定客户端的原生正文和请求头。生成的配置使用 fn 地址和应用独立身份。生成配置后仍显示待客户端确认，真实任务成功后再登记。

签到继续由浏览器 All API Hub 执行。中心接收逐账号结果，查看历史和规则，不额外发起一套签到任务。余额显示单位和实际观察时间，不把不同站点额度直接相加。

酒馆 RP 扩展在真实生成时上报模型、结果、耗时、首字与上游 Token，不主动测活。历史聊天只回填元数据，缺失站点和终态保留未知；酒馆本地 Token 估算单列。刷新酒馆后生效。

渠道评价提供调用统计与分页明细，支持按实际调用/历史留存、来源、渠道、模型、应用和结果筛选；Token、延迟、首字时间、流式状态、错误和采集缺口直接可见。渠道评价读取真实调用。既有资源导入后保留人工模式和网关原配置；要让中心调整某条 New API 渠道，在详情选择自动托管并应用。样本不足保留原优先级，外部修改引起的差异需人工处理。CPA 目前读取运行配置与 Manager 的持久调用记录；自动提降权只写 New API。

## 本地开发

Node.js 24 以上。后端第一次启动在数据目录生成管理密码，凭据不会放在前端代码。

```sh
npm ci
npm test
npm run build
npm run server
```

另一个终端运行 `npm run dev`，打开 <http://127.0.0.1:18322>；开发代理连接本机 18321 后端。`prototype/` 是接回的 Make 演示源码，`web/` 是连接真实 API 的产品界面，两者数据互不相通。

## 部署

`compose.yaml` 使用 fn 的内网地址和持久卷，镜像固定 Node 24 基础镜像摘要。首次部署前创建私有数据目录：

```sh
mkdir -p /vol2/1000/Docker/ai-resource-center/data
chmod 700 /vol2/1000/Docker/ai-resource-center/data
docker compose up -d --build --wait
```

`center.sqlite`、SQLite WAL、`master.key` 和管理密码在同一持久卷。备份必须同时保存数据库与主密钥；只备份数据库无法解密已有凭据。生产密钥、导入中间文件和本地联调目录均不进入 Git。
