export interface ContractVersionInput {
  partnerId: string;
  currency: string;
  dailyLimit: number;
  periodLimit: number;
  overageApprover?: string;
  validFrom: string;
  validTo?: string;
  /** 站点白名单，["*"] 表示全部站点。 */
  sites: string[];
  /** 车型范围，缺省或含 "*" 表示不限车型。 */
  vehicleModels?: string[];
  /** 账户范围，缺省或含 "*" 表示不限账户。 */
  accounts?: string[];
}

export interface StartSessionInput {
  sessionId: string;
  idempotencyKey: string;
  contractId: string;
  siteId: string;
  accountId?: string;
  vehicleModel?: string;
  /** 预估金额（报送币种）。 */
  amount: number;
  currency: string;
  /** 事件发生时刻；离线补传必填且早于当前时刻，准入按此时点判断。 */
  startedAt?: string;
  /** 占用有效期秒数，默认 4 小时。 */
  holdTtlSeconds?: number;
  /** 超额授权人，须与合同版本声明的 overageApprover 一致方可即时提额。 */
  approvedBy?: string;
}

export interface FragmentInput {
  fragmentId: string;
  seq: number;
  observedAt: string;
  /** 截至该片段的累计金额（报送币种）。 */
  amount: number;
  currency: string;
}

export interface EndSessionInput {
  amount: number;
  currency: string;
  endedAt?: string;
}

export interface ExemptionInput {
  contractId: string;
  currency: string;
  sessionId?: string;
  dayKey?: string;
  periodKey?: string;
  extraDaily?: number;
  extraPeriod?: number;
  approver: string;
  reason?: string;
}

export interface FxRateInput {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  effectiveAt: string;
}
