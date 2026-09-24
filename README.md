# 充电会话离线清分服务

用于站点离线补传的充电计量片段拼接，并在其上提供**漫游合同准入与额度占用**链路：
会话启动时冻结所见合同/汇率/担保版本并创建有期限占用，计量片段到达后逐步调整，
结束时结转真实金额并释放剩余量。项目采用 Koa、TypeScript、better-sqlite3，
保留独立迁移进程和可注入的应用构造函数。

## 本地约定

数据库默认写入 `data/charging.sqlite3`，可通过 `APP_DB_PATH` 改为当前工程内的其他文件；
测试通过可注入的应用构造函数使用内存库。服务不需要远程数据库或缓存，
并发安全仅依赖 SQLite 自身事务。

## 常用命令

```bash
npm install
npm run db:upgrade
npm test
npm start
```

Docker 镜像在构建阶段执行自动化测试，运行时监听 `PORT` 指定的端口，未设置时使用 8080。

## 编译或构建

```bash
npm run build
```

## 领域模型

| 表 | 作用 |
| --- | --- |
| `contracts` / `contract_versions` | 合同主档与不可变版本：合作方、币种、单日/账期上限、超额授权人、有效区间 |
| `contract_version_sites` / `contract_version_scopes` | 版本冻结的站点白名单、车型/账户范围（`*` 为通配） |
| `contract_lifecycle` / `site_eligibility_events` | 暂停/恢复、站点资格流水（单调 `seq`），支持按历史时点判断与在途变化检测 |
| `guarantees` | 合同担保，可撤回 |
| `fx_rate_versions` | 按生效时间选取的汇率版本 |
| `sessions` | 已准入会话；冻结合同版本、汇率、担保 ID、生命周期/站点序号 |
| `holds` | 每会话一条有期限占用（`held` / `expired` / `captured`） |
| `quota_ledger` | 有符号额度分录（hold/adjust/release/capture/expire），不透支判定只认真实净额 |
| `meter_fragments` | 离线计量片段，按序号递增、累计金额不回退 |
| `exemptions` | 人工或超额授权人产生的窗口提额记录 |
| `risk_reviews` | 在途会话前提变化或超额时的待复核任务（绝不静默中止会话） |
| `settlements` | 结束生成草稿，签署后成为离线补传不可越过的屏障 |
| `admission_events` | 每次启动尝试（admit/replay/reject/conflict）留痕 |

## 关键语义

- **版本冻结**：会话启动时按事件发生时刻选取合同版本、汇率版本和有效担保并写入会话；
  之后发布新版本、调整汇率不影响进行中会话。
- **幂等**：相同 `idempotencyKey` + 相同请求体返回原占用（`replay`）；同键异文返回 `409`
  并写 `conflict` 事件。
- **不透支**：准入在单条 `BEGIN IMMEDIATE` 事务内完成“读台账净额→判定→写占用”，
  多进程并发下后到申请阻塞，单日/账期任一窗口超限即拒绝。
- **超额授权**：突破上限时，仅当请求 `approvedBy` 与合同版本声明的 `overageApprover`
  一致才自动提额放行；否则只能由人工豁免放行，两者都留痕。
- **在途保护**：合同暂停、担保撤回、站点资格变化只阻断**未开始**会话；进行中会话不被
  静默中止，而是产生 `risk_reviews` 待人工复核（waive/reject）。
- **离线补传**：`startedAt` 为事件发生时刻，准入按该时刻的版本/资格/担保/汇率判断；
  若事件所属账期已在该时刻之后被签署结算锁定，拒绝（`settlement_barrier`）。
- **占用到期**：到期未结束的占用冲减台账并置 `expired`，同时转复核；额度立即归还窗口，
  会话结束时按真实金额重新入账并出结算草稿。
- **重启恢复**：启动时先补做过期释放，再补在途前提变化的复核；另设 60s 周期清扫。
- **全链路追溯**：`GET /sessions/:id/trace` 从一次放行或拒绝追到冻结条款、担保、
  额度分录、豁免、复核与最终结算去向；被拒会话无 `sessions` 行但仍有准入事件。

## HTTP 接口

管理端：

- `POST /admin/contracts`，`POST /admin/contracts/:id/versions`，
  `POST /admin/contracts/:id/suspension`
- `POST /admin/guarantees`，`POST /admin/guarantees/:id/withdraw`
- `POST /admin/sites/:id/eligibility`
- `POST /admin/fx-rates`，`POST /admin/exemptions`
- `GET /admin/reviews`，`POST /admin/reviews/:id/resolve`
- `POST /admin/sweep`（手动触发过期释放与复核发现）

会话：

- `POST /sessions/start`
- `POST /sessions/:id/fragments`
- `POST /sessions/:id/end`
- `GET /sessions/:id/trace`
- `POST /settlements/:id/sign`

错误统一为 `{ "error": { "code", "message", "details" } }`；准入类拒绝返回 `422`，
冲突 `409`，入参错误 `400`。

### 启动请求示例

```json
{
  "sessionId": "SESS-1",
  "idempotencyKey": "partner-x-20260924-0001",
  "contractId": "C1",
  "siteId": "S1",
  "accountId": "A1",
  "vehicleModel": "M1",
  "amount": 100,
  "currency": "CNY",
  "startedAt": "2026-09-24T08:00:00Z",
  "holdTtlSeconds": 14400,
  "approvedBy": "boss"
}
```

`startedAt` 缺省表示在线启动；外币金额按发生时刻最新汇率版本换算到合同币种并冻结。
