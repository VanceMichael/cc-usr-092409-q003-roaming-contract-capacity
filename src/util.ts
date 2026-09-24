import { createHash, randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return randomUUID();
}

/** 单日窗口键（UTC YYYY-MM-DD）。 */
export function dayKey(at: Date | string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toISOString().slice(0, 10);
}

/** 账期窗口键（按月，UTC YYYY-MM）。 */
export function periodKey(at: Date | string): string {
  return dayKey(at).slice(0, 7);
}

export function parseTime(value: string | undefined, field: string): Date {
  if (!value) throw new Error(`missing ${field}`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ${field}: ${value}`);
  return d;
}

/** 稳定序列化后哈希，用于同键异文（幂等键相同但请求体不同）冲突判定。 */
export function requestHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 用冻结汇率换算到合同币种；同币种按 1。 */
export function convert(amount: number, rate: number): number {
  return round2(amount * rate);
}

/** 金额统一保留两位小数后比较与汇总，规避浮点误差导致的误判。 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
