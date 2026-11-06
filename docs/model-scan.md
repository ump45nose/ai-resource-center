# 扫描渠道的模型可用性

启动一次扫描后，打开生成的 `index.html`，按站点、模型和分组筛选。页面同时显示站方成功率、近期走势、首字延迟、吞吐，以及自己的 key 是否列出该模型。

```sh
npm run scan:models -- --data-dir /data
```

结果保存在 `/data/model-scans/日期/`，包括可直接打开的 HTML 和 `scan.json`。每站最后一次结果也保存在中心数据库的 `modelScan` 中，不进入自己的调用统计或渠道自动评分。

## 扫描哪些渠道

默认读取通用渠道，包含人工暂停的连接。与 RP 连接重复的站点按网站地址、API 地址和已登记别名排除。RP 本身不扫描。

第一次启动时可以保存额外排除项，之后的扫描继续使用这份配置：

```sh
npm run scan:models -- --data-dir /data \
  --exclude-host token.sensenova.cn
```

`--exclude-host` 替换额外排除清单，不改变 RP 排除规则。`--category general --category media` 可增加生图渠道；默认不会因为模型名或站点同属一个品牌而合并不同地址。

需要额外查看一个模型广场时：

```sh
npm run scan:models -- --data-dir /data --url https://api.42x.shop
```

额外地址只读取公开站点指标，没有绑定个人 key，不会继承别的域名的凭据。

## 需要登录的站点，用 Chrome 补采

服务器读不到，但 Chrome 已经登录的站点，可以使用本机已有 Browser Relay 补采：

```sh
npm run scan:models:browser -- --input /path/to/scan.json
```

只补“需要登录”或 HTTP 403 的站点；指定 `--site https://api.42x.shop` 可只补一个。程序在后台打开模型广场，复用浏览器会话和页面实际请求中的账号路由标识，读完关闭自己开的标签，不导出 Cookie、Token，不替你登录或处理验证码。登录过期则保留错误。

JSON 和同目录 HTML 会一起更新。若结果来自 fn，将这两个文件放回原目录后，可将补采数据接回中心：

```sh
npm run scan:models -- --data-dir /data \
  --import-report /data/model-scans/日期/scan.json
```

fn 可用独立容器运行扫描，不重启正在使用的中心：

```sh
docker run --rm \
  -v /vol2/1000/Docker/ai-resource-center/data:/data \
  ai-resource-center:model-scan-20261020 npm run scan:models
```

## 数据怎么读

| 数据 | 来源 | 用法 |
| --- | --- | --- |
| 站点目录与分组 | `GET /api/pricing` | 确认站点列出的模型和分组 |
| 模型总体表现 | `GET /api/perf-metrics/summary?hours=24` | 获取站方成功率、延迟、吞吐和近期统计点 |
| 分组表现 | `GET /api/perf-metrics?model=...&hours=24` | 区分同一模型在不同分组的表现 |
| 个人 key 目录 | 使用中心已有凭据 `GET /v1/models` | 确认该 key 的目录是否列出模型，不等同于调用成功 |

扫描只发 GET，不生成内容，不创建 key，不恢复暂停，不调整网关模型和权重。最多同时读取 5 个站点；同站的模型分组指标顺序读取。

失败保留在对应接口：需要登录、HTTP 403、限流、超时、接口不存在、返回网页、格式待适配分别显示。不能据此把整个网站标为关闭，也不会把无统计的模型记为 0%。

站方统计不与 Pi 任务结果或自己的调用记录相加。历史统计中已经不在当前目录的模型不进入候选列表。返回样本数、统计窗口或时间点时原样保留，未提供的字段保持未知。最近三个点可能跨过没有调用的小时，不能解释成连续三小时。

候选按站方成功率 ≥98%、最近三点均 ≥98% 标注；最后一个有时间的桶距扫描超过两小时，显示“较久无记录”。“重点模型系列”只是便于查找的名称筛选，不评判模型能力。

## 为什么采用这一种实现

- [New API 原生性能接口](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.45/controller/perf_metrics.go) 已提供近况与分组查询。直接读取，避免重新构造站方的成功率。
- [All API Hub 模型目录](https://github.com/qixing-jk/all-api-hub/blob/main/docs/docs/model-list.md) 区分账号目录和 API 凭据目录，验证另发 probe。这里复用这种来源分离方式，不触发验证。
- [Metapi 上游适配](https://github.com/cita-777/metapi/blob/main/src/server/services/platforms/newApi.ts) 已处理目录发现，但引入整套网关不能补齐所有站点的性能数据，本次不增加网关。
- [PriceAI 接口发现说明](https://github.com/dimthink/PriceAI/blob/main/.agents/skills/transit-onboard/references/new-api-discovery.md) 区分站方数据和实测；其引用的扫描脚本在本次检索时返回 404，只参考公开思路，不引入源码或它采集的数据。

程序复用中心的 SQLite、凭据解密和 URL 规范化，不新增运行依赖。各站接口版本不同，采用已确认的 New API 响应格式；其他格式显示待适配，不猜测可用率。
