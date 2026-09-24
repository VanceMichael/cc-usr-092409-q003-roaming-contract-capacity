# 充电会话离线清分服务

拼接站点离线补传的充电计量片段，并在会话准入环节落合同条款冻结、额度占用与全程追溯。项目采用 Koa 与 TypeScript，保留独立迁移进程和可注入的应用构造函数。

## 本地约定

数据库默认写入 `data/charging.sqlite3`，可通过 `APP_DB_PATH` 改为当前工程内的其他文件。服务不需要远程数据库或缓存；金额一律使用合同币种的整数最小货币单位，时间一律使用 UTC ISO-8601。

```bash
npm install
npm run db:upgrade
npm test
npm start
```

Docker 镜像在构建阶段执行自动化测试（含跨连接并发占用测试），运行时监听 `PORT` 指定的端口，未设置时使用 8080。

## 合同准入与额度占用链路

- **合同目录**：合同声明合作方、站点白名单、车型/账户范围、有效区间、币种、单日与账期上限、超额授权人；合同版本只向前演进，新版本生效时自动关闭旧版本的开放区间。
- **准入冻结**：会话启动在单个 SQLite `IMMEDIATE` 事务内完成 as-of 判定，冻结所见合同版本与汇率版本，按预估金额创建有期限占用（`APP_HOLD_TTL_SECONDS`，默认 4 小时）。
- **占用生命周期**：计量片段按累计金额逐步调增/释放占用；结束时释放全部占用并把真实金额结转到 `consumed`；占用到期由扫描器释放。
- **幂等与冲突**：相同启动键返回原占用；同键异文落 `conflict` 决策并拒绝；并发申请由事务串行化保证不透支单日/账期/担保额度。
- **风险不静默**：合同暂停、担保撤回、站点取消资格只阻断未开始会话；在途会话转入风险复核队列，由人工豁免放行（占用追补到真实计量）或显式终止。
- **离线时效**：开始/计量/结束事件全部按 `eventTime` 做 as-of 判定；晚到事件不得越过已签署账期（`period_locks`）。
- **可追溯**：`/trace/:key` 聚合准入决策与额度快照、冻结条款（含白名单/车型/账户）、额度台账流水、计量片段、风险复核、人工豁免与最终结算去向。
- **重启恢复**：进程启动即执行一次过期释放与在途会话风险扫描，之后按 `APP_SWEEP_INTERVAL_MS` 周期执行。

## 主要接口

管理面（示例）：

- `POST /admin/partners`、`POST /admin/sites`、`POST /admin/contracts`
- `POST /admin/contracts/:id/versions`（合同版本）
- `POST /admin/contracts/:id/status`（active/paused，立即扫描在途会话）
- `POST /admin/sites/:id/status`（qualified/disqualified）
- `POST /admin/partners/:id/guarantees`（正数入账、负数撤回）
- `POST /admin/fx-rates`（整数分子/分母汇率，按生效时刻版本化）
- `POST /admin/periods/sign`（签署账期，锁死晚到事件）
- `POST /admin/quota-adjustments`、`POST /admin/exemptions`（人工追加额度 / 超额授权）
- `GET /admin/reviews`、`POST /admin/reviews/:id/resolve`（风险复核队列与裁决）

会话面：

- `POST /sessions/start`（`requestKey` 为幂等键，`eventTime` 为发生时刻）
- `POST /sessions/:id/meter`（`segmentNo` + `cumulativeAmount`）
- `POST /sessions/:id/end`（可选 `finalAmount`）
- `GET /sessions/:id`、`GET /trace/:key`
- `POST /ops/sweep`（立即执行过期释放与风险扫描）

## 编译或构建

```bash
npm run build
```
