-- 合同主档：合作方声明；暂停/恢复走生命周期流水，支持按历史时点判断
CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL

);

-- 合同生命周期流水：action = suspend | resume；seq 单调递增，会话启动时冻结所见序号
CREATE TABLE IF NOT EXISTS contract_lifecycle (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  action      TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_contract ON contract_lifecycle(contract_id, occurred_at);

-- 合同版本：发布即不可变，会话启动时冻结所见版本（站点/车型/账户范围、有效区间、币种、上限、超额授权人）
CREATE TABLE IF NOT EXISTS contract_versions (
  contract_id        TEXT NOT NULL REFERENCES contracts(contract_id),
  version            INTEGER NOT NULL,
  partner_id         TEXT NOT NULL,
  currency           TEXT NOT NULL,
  daily_limit        REAL NOT NULL,
  period_limit       REAL NOT NULL,
  period_granularity TEXT NOT NULL DEFAULT 'monthly',
  overage_approver   TEXT,
  valid_from         TEXT NOT NULL,
  valid_to           TEXT,
  published_at       TEXT NOT NULL,
  PRIMARY KEY (contract_id, version)
);

-- 版本适用站点白名单（'*' 表示全部站点）
CREATE TABLE IF NOT EXISTS contract_version_sites (
  contract_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  site_id     TEXT NOT NULL,
  PRIMARY KEY (contract_id, version, site_id)
);

-- 版本适用范围：scope_type = 'vehicle_model' 或 'account'，'*' 为通配
CREATE TABLE IF NOT EXISTS contract_version_scopes (
  contract_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  scope_type  TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  PRIMARY KEY (contract_id, version, scope_type, scope_value)
);

-- 站点资格流水：action = qualify | disqualify；seq 单调递增，会话启动时冻结所见序号。
-- 无任何记录视为有资格。
CREATE TABLE IF NOT EXISTS site_eligibility_events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_elig_site ON site_eligibility_events(site_id, occurred_at);

-- 担保：合同额度的资金后盾，撤回后不再支撑新会话
CREATE TABLE IF NOT EXISTS guarantees (
  guarantee_id TEXT PRIMARY KEY,
  contract_id  TEXT NOT NULL REFERENCES contracts(contract_id),
  amount       REAL NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active', -- active | withdrawn
  created_at   TEXT NOT NULL,
  withdrawn_at TEXT
);

-- 汇率版本：按生效时间选取，会话启动时冻结版本与汇率
CREATE TABLE IF NOT EXISTS fx_rate_versions (
  version        INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency  TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate           REAL NOT NULL,
  effective_at   TEXT NOT NULL,
  published_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fx_pair_time
  ON fx_rate_versions(base_currency, quote_currency, effective_at);

-- 充电会话：仅为已准入会话建账
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  contract_id         TEXT NOT NULL,
  contract_version    INTEGER NOT NULL,
  site_id             TEXT NOT NULL,
  account_id          TEXT,
  vehicle_model       TEXT,
  amount_currency     TEXT NOT NULL, -- 预估/计量报送币种
  fx_version          INTEGER,        -- 同币种时为 NULL，汇率按 1 冻结
  fx_rate             REAL NOT NULL,
  day_key             TEXT NOT NULL,  -- 归属单日窗口（事件发生时刻，UTC YYYY-MM-DD）
  period_key          TEXT NOT NULL,  -- 归属账期窗口（UTC YYYY-MM）
  event_started_at    TEXT NOT NULL,  -- 事件发生时刻（离线补传以此为准）
  recorded_started_at TEXT NOT NULL,  -- 服务受理时刻
  offline             INTEGER NOT NULL DEFAULT 0,
  estimated_amount    REAL NOT NULL,
  held_amount         REAL NOT NULL,  -- 当前占用（合同币种）
  captured_amount     REAL,
  status              TEXT NOT NULL,  -- in_progress | completed
  frozen_guarantee_ids TEXT NOT NULL, -- 启动时冻结的有效担保 JSON 数组
  frozen_lifecycle_seq INTEGER,       -- 启动时所见合同生命周期最后序号
  frozen_site_seq      INTEGER,       -- 启动时所见站点资格最后序号
  request_hash        TEXT NOT NULL,
  settlement_id       TEXT,
  ended_at            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 计量片段：离线补传的充电过程数据，驱动占用逐步调整
CREATE TABLE IF NOT EXISTS meter_fragments (
  fragment_id    TEXT NOT NULL,
  session_id     TEXT NOT NULL REFERENCES sessions(session_id),
  seq            INTEGER NOT NULL,
  observed_at    TEXT NOT NULL, -- 片段发生时刻
  amount         REAL NOT NULL, -- 截至该片段累计金额（报送币种）
  currency       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (session_id, fragment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fragment_session_seq
  ON meter_fragments(session_id, seq);

-- 额度占用：每会话一条，调整原地更新并在台账留痕；有期限，过期由清扫任务释放
CREATE TABLE IF NOT EXISTS holds (
  hold_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),
  contract_id    TEXT NOT NULL,
  currency       TEXT NOT NULL,
  initial_amount REAL NOT NULL,
  amount         REAL NOT NULL,
  status         TEXT NOT NULL, -- held | expired | captured
  expires_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  captured_at    TEXT
);

-- 额度台账：有符号分录，同一 SQLite 事务内汇总保证不透支
CREATE TABLE IF NOT EXISTS quota_ledger (
  ledger_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  currency    TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  period_key  TEXT NOT NULL,
  session_id  TEXT,
  hold_id     TEXT,
  entry_type  TEXT NOT NULL, -- hold | adjust | release | capture | expire
  amount      REAL NOT NULL, -- 合同币种，占用为正、释放为负
  created_at  TEXT NOT NULL,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_contract_day
  ON quota_ledger(contract_id, currency, day_key);
CREATE INDEX IF NOT EXISTS idx_ledger_contract_period
  ON quota_ledger(contract_id, currency, period_key);
CREATE INDEX IF NOT EXISTS idx_ledger_session ON quota_ledger(session_id);

-- 人工豁免：抬高指定单日/账期窗口上限；超额授权人须与合同版本声明一致
CREATE TABLE IF NOT EXISTS exemptions (
  exemption_id TEXT PRIMARY KEY,
  contract_id  TEXT NOT NULL,
  currency     TEXT NOT NULL,
  session_id   TEXT,
  day_key      TEXT,
  period_key   TEXT,
  extra_daily  REAL NOT NULL DEFAULT 0,
  extra_period REAL NOT NULL DEFAULT 0,
  approver     TEXT NOT NULL,
  reason       TEXT,
  source       TEXT NOT NULL DEFAULT 'manual', -- manual | review
  created_at   TEXT NOT NULL
);

-- 风险复核：合同暂停/担保撤回/站点资格变化只影响在途会话的去向，不静默中止
CREATE TABLE IF NOT EXISTS risk_reviews (
  review_id       TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | waived | rejected
  detail          TEXT,
  detected_at     TEXT NOT NULL,
  resolved_at     TEXT,
  resolver        TEXT,
  resolution_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_session_reason
  ON risk_reviews(session_id, reason);
CREATE INDEX IF NOT EXISTS idx_review_status ON risk_reviews(status);

-- 结算：结束时生成草稿，签署后成为离线补传不可越过的屏障
CREATE TABLE IF NOT EXISTS settlements (
  settlement_id TEXT PRIMARY KEY,
  contract_id   TEXT NOT NULL,
  session_id    TEXT NOT NULL UNIQUE,
  day_key       TEXT NOT NULL,
  period_key    TEXT NOT NULL,
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | signed
  created_at    TEXT NOT NULL,
  signed_at     TEXT,
  signed_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_settlement_window
  ON settlements(contract_id, period_key, day_key, status);

-- 准入事件：每次启动尝试（放行/拒绝/冲突/幂等重放）都留痕，供追溯
CREATE TABLE IF NOT EXISTS admission_events (
  event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL,
  request_hash     TEXT,
  decision         TEXT NOT NULL, -- admit | reject | conflict | replay
  reason           TEXT,
  contract_id      TEXT,
  contract_version INTEGER,
  fx_version       INTEGER,
  occurred_at      TEXT,
  evaluated_at     TEXT NOT NULL,
  detail           TEXT
);
CREATE INDEX IF NOT EXISTS idx_admission_session ON admission_events(session_id);
