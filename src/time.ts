/** 全服务统一使用 UTC ISO-8601 字符串（词法序即时间序），金额为整数最小货币单位。 */

export function nowIso(): string {
  return new Date().toISOString();
}

/** 解析并归一化时间；缺省取当前时刻。拒绝非法时间，避免词法比较失真。 */
export function resolveTime(input?: string | null, fallback: string = nowIso()): string {
  if (input === undefined || input === null || input === "") return fallback;
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new HttpError(400, "invalid_event_time", `无法解析时间：${input}`);
  return new Date(ms).toISOString();
}

export function dayKey(at: string): string {
  return at.slice(0, 10); // YYYY-MM-DD（UTC）
}

export function periodKey(at: string): string {
  return at.slice(0, 7); // YYYY-MM（UTC 账期）
}

export function addSeconds(at: string, seconds: number): string {
  return new Date(Date.parse(at) + seconds * 1000).toISOString();
}

/** amount * n / d，向上取整：冻结汇率下宁可多占用担保，不透支。 */
export function convertCeil(amount: number, numerator: number, denominator: number): number {
  return Math.ceil((amount * numerator) / denominator);
}

/** 业务错误，携带 HTTP 状态与机器可读码。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}
