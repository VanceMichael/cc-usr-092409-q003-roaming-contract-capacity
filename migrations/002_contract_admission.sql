-- 合作方（漫游车队运营商）
CREATE TABLE IF NOT EXISTS partners (
  partner_id TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 合同：一行一个合同，条款演进全部走 contract_versions
CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY,
  partner_id  TEXT NOT NULL REFERENCES partners(partner_id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 合同版本：有效区间、币种、单日/账期上限、超额授权人、车型/账户范围
-- 金额一律为合同币种的最小货币单位（INTEGER）
CREATE TABLE IF NOT EXISTS contract_versions (
  version_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id      TEXT NOT NULL REFERENCES contracts(contract_id),
  version_tag      TEXT NOT NULL UNIQUE,
  effective_from   TEXT NOT NULL,            -- 含
  effective_to     TEXT,                     -- NULL 表示开放
  currency         TEXT NOT NULL,
  daily_limit      INTEGER NOT NULL CHECK (daily_limit >= 0),
  period_limit     INTEGER NOT NULL CHECK (period_limit >= 0),
  overage_approver TEXT,                     -- NULL 表示未授权任何人超额
  vehicle_types    TEXT,                     -- JSON 数组，NULL 表示不限车型
  accounts         TEXT,                     -- JSON 数组，NULL 表示不限账户
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_contract_versions_lookup
  ON contract_versions(contract_id, effective_from);

-- 版本适用站点白名单
CREATE TABLE IF NOT EXISTS contract_version_sites (
  version_id INTEGER NOT NULL REFERENCES contract_versions(version_id),
  site_id    TEXT NOT NULL,
  PRIMARY KEY (version_id, site_id)
);

-- 站点主数据
CREATE TABLE IF NOT EXISTS sites (
  site_id    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 站点资格事件流（qualified / disqualified），按发生时刻做 as-of 判定
CREATE TABLE IF NOT EXISTS site_status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     TEXT NOT NULL REFERENCES sites(site_id),
  status      TEXT NOT NULL CHECK (status IN ('qualified', 'disqualified')),
  reason      TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_status_lookup ON site_status_events(site_id, occurred_at);

-- 合同状态事件流（active / paused），合同暂停只阻断未开始会话
CREATE TABLE IF NOT EXISTS contract_status_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL REFERENCES contracts(contract_id),
  status      TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  reason      TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_status_lookup ON contract_status_events(contract_id, occurred_at);

-- 担保事件流：正数入账、负数撤回；每个合作方仅允许一种担保币种
CREATE TABLE IF NOT EXISTS guarantee_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id  TEXT NOT NULL REFERENCES partners(partner_id),
  currency    TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_guarantee_lookup ON guarantee_events(partner_id, occurred_at);

-- 汇率版本：amount_in_to = amount * numerator / denominator（向上取整用于担保覆盖）
CREATE TABLE IF NOT EXISTS fx_rates (
  rate_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency  TEXT NOT NULL,
  to_currency    TEXT NOT NULL,
  numerator      INTEGER NOT NULL CHECK (numerator > 0),
  denominator    INTEGER NOT NULL CHECK (denominator > 0),
  effective_from TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fx_lookup ON fx_rates(from_currency, to_currency, effective_from);

-- 充电会话：启动时冻结合同版本与汇率版本，占用随计量调整、结束结转
CREATE TABLE IF NOT EXISTS charging_sessions (
  session_id          TEXT PRIMARY KEY,          -- 即启动请求幂等键
  request_hash        TEXT NOT NULL,
  contract_id         TEXT NOT NULL REFERENCES contracts(contract_id),
  version_id          INTEGER NOT NULL REFERENCES contract_versions(version_id),
  fx_rate_id          INTEGER REFERENCES fx_rates(rate_id),
  partner_id          TEXT NOT NULL REFERENCES partners(partner_id),
  guarantee_currency  TEXT,
  site_id             TEXT NOT NULL,
  vin                 TEXT,
  vehicle_type        TEXT,
  account_id          TEXT,
  currency            TEXT NOT NULL,
  estimated_amount    INTEGER NOT NULL CHECK (estimated_amount >= 0),
  held_amount         INTEGER NOT NULL CHECK (held_amount >= 0),          -- 合同币种当前占用
  held_converted      INTEGER NOT NULL DEFAULT 0 CHECK (held_converted >= 0), -- 担保币种冻结汇率下的占用
  measured_amount     INTEGER NOT NULL DEFAULT 0,                         -- 计量片段确认的累计金额
  settled_amount      INTEGER,
  day_key             TEXT NOT NULL,           -- YYYY-MM-DD（UTC，按事件发生时刻）
  period_key          TEXT NOT NULL,           -- YYYY-MM（UTC，账期）
  start_event_time    TEXT NOT NULL,
  start_seen_at       TEXT NOT NULL,
  end_event_time      TEXT,
  hold_expires_at     TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                          'started', 'risk_review', 'completed',
                          'expired', 'aborted')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_contract_status ON charging_sessions(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_partner_status ON charging_sessions(partner_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_site_status ON charging_sessions(site_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON charging_sessions(status, hold_expires_at);

-- 额度台账：所有额度变化的唯一权威流水，支撑按发生时刻重放与追溯
-- bucket='held' 为占用（hold/adjust/release 带符号），'consumed' 为结转消费，'manual' 为人工额度调整
CREATE TABLE IF NOT EXISTS quota_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL REFERENCES contracts(contract_id),
  period_key  TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  session_id  TEXT REFERENCES charging_sessions(session_id),
  ref_type    TEXT,                          -- exemption / review / period_lock 等
  ref_id      TEXT,
  bucket      TEXT NOT NULL CHECK (bucket IN ('held', 'consumed', 'manual')),
  change_type TEXT NOT NULL,                 -- hold/adjust/release/settle/manual_adjust
  amount      INTEGER NOT NULL,              -- 带符号，合同币种
  converted_amount INTEGER,                 -- held 行在冻结汇率下的担保币种带符号占用
  currency    TEXT NOT NULL,
  event_time  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_contract_day ON quota_ledger(contract_id, day_key, event_time);
CREATE INDEX IF NOT EXISTS idx_ledger_contract_period ON quota_ledger(contract_id, period_key, event_time);
CREATE INDEX IF NOT EXISTS idx_ledger_session ON quota_ledger(session_id);

-- 计量片段（离线补传，按片段序号去重）
CREATE TABLE IF NOT EXISTS meter_segments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT NOT NULL REFERENCES charging_sessions(session_id),
  segment_no       INTEGER NOT NULL,
  cumulative_amount INTEGER NOT NULL CHECK (cumulative_amount >= 0),
  event_time       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (session_id, segment_no)
);

-- 风险复核：进行中会话遇合同暂停 / 担保撤回 / 站点资格变化转入，绝不静默中止
CREATE TABLE IF NOT EXISTS risk_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES charging_sessions(session_id),
  reason      TEXT NOT NULL CHECK (reason IN (
                'contract_paused', 'guarantee_withdrawn', 'site_disqualified', 'overage_unauthorized', 'over_cap_settle')),
  detail      TEXT,
  status      TEXT NOT NULL CHECK (status IN ('open', 'exempted', 'aborted')) DEFAULT 'open',
  detected_event_time TEXT NOT NULL,
  opened_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON risk_reviews(status);

-- 人工豁免 / 超额授权：approver 必须命中合同版本声明的 overage_approver
-- scope：session=指定启动键，day=YYYY-MM-DD，period=YYYY-MM
CREATE TABLE IF NOT EXISTS manual_exemptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id   INTEGER REFERENCES risk_reviews(id),
  session_id  TEXT,                          -- 可能在会话创建前预授权，故不加外键
  contract_id TEXT NOT NULL REFERENCES contracts(contract_id),
  kind        TEXT NOT NULL CHECK (kind IN ('overage', 'risk_resume')),
  scope_type  TEXT NOT NULL DEFAULT 'session' CHECK (scope_type IN ('session', 'day', 'period')),
  scope_value TEXT NOT NULL,
  amount      INTEGER NOT NULL DEFAULT 0,    -- overage：额外授权额度
  approver    TEXT NOT NULL,
  note        TEXT,
  granted_at  TEXT NOT NULL,                 -- 授权生效时刻（离线补录按事件时刻，参与 as-of 判定）
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 单会话结算（结束时结转真实金额）
CREATE TABLE IF NOT EXISTS settlements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL UNIQUE REFERENCES charging_sessions(session_id),
  contract_id   TEXT NOT NULL REFERENCES contracts(contract_id),
  period_key    TEXT NOT NULL,
  day_key       TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount >= 0),
  currency      TEXT NOT NULL,
  event_time    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_settlements_contract_period ON settlements(contract_id, period_key);

-- 账期签署锁：晚到事件不得越过已签署结算
CREATE TABLE IF NOT EXISTS period_locks (
  contract_id TEXT NOT NULL REFERENCES contracts(contract_id),
  period_key  TEXT NOT NULL,
  signed_at   TEXT NOT NULL,
  note        TEXT,
  PRIMARY KEY (contract_id, period_key)
);

-- 每次准入尝试（放行/拒绝/冲突/幂等重放）留痕，冻结条款与额度快照
CREATE TABLE IF NOT EXISTS admission_decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  request_key      TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  contract_id      TEXT REFERENCES contracts(contract_id),
  session_id       TEXT REFERENCES charging_sessions(session_id),
  decision         TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'conflict', 'replay')),
  reasons          TEXT,                    -- JSON 数组
  snapshot         TEXT,                    -- JSON：版本条款/汇率/担保/已用额度
  event_time       TEXT NOT NULL,
  decided_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_request ON admission_decisions(request_key);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON admission_decisions(session_id);
