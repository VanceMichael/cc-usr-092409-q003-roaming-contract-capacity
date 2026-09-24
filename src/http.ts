import Koa from "koa";
import Router from "@koa/router";
import type { DB } from "./db.js";
import {
  addContractVersion,
  addFxRate,
  addGuarantee,
  createContract,
  registerPartner,
  registerSite,
  setContractStatus,
  setSiteStatus,
  signPeriod,
} from "./catalog.js";
import {
  addManualAdjustment,
  applyMeterSegment,
  endSession,
  startSession,
  sweepExpiredHolds,
  sweepRiskChanges,
} from "./sessions.js";
import {
  grantExemption,
  listOpenReviews,
  resolveReview,
  sessionView,
  trace,
} from "./reviews.js";
import { HttpError, nowIso, resolveTime } from "./time.js";

async function readJson(ctx: Koa.ParameterizedContext): Promise<Record<string, unknown>> {
  if (ctx.method === "GET" || ctx.method === "DELETE") return {};
  return await new Promise((resolve, reject) => {
    let raw = "";
    ctx.req.setEncoding("utf8");
    ctx.req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new HttpError(413, "payload_too_large", "请求体超过 1MB"));
        ctx.req.destroy();
      }
    });
    ctx.req.on("end", () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new HttpError(400, "invalid_json", "请求体必须为 JSON 对象");
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        if (err instanceof HttpError) reject(err);
        else reject(new HttpError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
    ctx.req.on("error", reject);
  });
}

function str(body: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, "field_required", `缺少字段：${key}`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, "invalid_field", `字段必须为字符串：${key}`);
  return value;
}

function int(body: Record<string, unknown>, key: string, required = true): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, "field_required", `缺少字段：${key}`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpError(400, "invalid_field", `字段必须为整数：${key}`);
  }
  return value;
}

export interface AppDeps {
  db: DB;
  /** 注入时钟，便于测试过期释放。 */
  clock?: () => string;
}

export function buildApp(deps: AppDeps): Koa {
  const { db } = deps;
  const app = new Koa();
  const router = new Router();

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.status = err.status;
        ctx.body = { error: err.code, message: err.message, ...(err.extra ? { details: err.extra } : {}) };
      } else {
        ctx.status = 500;
        ctx.body = { error: "internal_error", message: (err as Error).message };
        ctx.app.emit("error", err, ctx);
      }
    }
  });

  router.get("/health", (ctx) => {
    ctx.body = { status: "ok", service: "charging-clearing" };
  });

  // ---- 管理面：合作方 / 站点 / 合同 / 担保 / 汇率 -------------------------

  router.post("/admin/partners", async (ctx) => {
    const body = await readJson(ctx);
    registerPartner(db, { partnerId: str(body, "partnerId")!, name: str(body, "name")! });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.post("/admin/sites", async (ctx) => {
    const body = await readJson(ctx);
    registerSite(db, {
      siteId: str(body, "siteId")!,
      qualified: body.qualified === undefined ? undefined : Boolean(body.qualified),
      occurredAt: str(body, "occurredAt", false),
    });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.post("/admin/contracts", async (ctx) => {
    const body = await readJson(ctx);
    createContract(db, {
      contractId: str(body, "contractId")!,
      partnerId: str(body, "partnerId")!,
      activeAt: str(body, "activeAt", false),
    });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.post("/admin/contracts/:id/versions", async (ctx) => {
    const body = await readJson(ctx);
    const versionId = addContractVersion(db, ctx.params.id, {
      versionTag: str(body, "versionTag")!,
      effectiveFrom: str(body, "effectiveFrom", false),
      currency: str(body, "currency")!,
      dailyLimit: int(body, "dailyLimit")!,
      periodLimit: int(body, "periodLimit")!,
      overageApprover: str(body, "overageApprover", false),
      vehicleTypes: (body.vehicleTypes as string[] | undefined | null) ?? null,
      accounts: (body.accounts as string[] | undefined | null) ?? null,
      sites: body.sites as string[],
    });
    ctx.status = 201;
    ctx.body = { ok: true, versionId };
  });

  router.post("/admin/contracts/:id/status", async (ctx) => {
    const body = await readJson(ctx);
    const status = str(body, "status")!;
    if (status !== "active" && status !== "paused") {
      throw new HttpError(400, "invalid_status", "status 必须为 active 或 paused");
    }
    const occurredAt = setContractStatus(db, {
      contractId: ctx.params.id,
      status,
      reason: str(body, "reason", false),
      occurredAt: str(body, "occurredAt", false),
    });
    // 状态变化后立即扫描在途会话：暂停只转复核，不静默中止
    sweepRiskChanges(db, deps.clock ? deps.clock() : occurredAt);
    ctx.body = { ok: true, occurredAt };
  });

  router.post("/admin/sites/:id/status", async (ctx) => {
    const body = await readJson(ctx);
    const status = str(body, "status")!;
    if (status !== "qualified" && status !== "disqualified") {
      throw new HttpError(400, "invalid_status", "status 必须为 qualified 或 disqualified");
    }
    const occurredAt = setSiteStatus(db, {
      siteId: ctx.params.id,
      status,
      reason: str(body, "reason", false),
      occurredAt: str(body, "occurredAt", false),
    });
    sweepRiskChanges(db, deps.clock ? deps.clock() : occurredAt);
    ctx.body = { ok: true, occurredAt };
  });

  router.post("/admin/partners/:id/guarantees", async (ctx) => {
    const body = await readJson(ctx);
    const occurredAt = addGuarantee(db, {
      partnerId: ctx.params.id,
      delta: int(body, "delta")!,
      currency: str(body, "currency", false),
      occurredAt: str(body, "occurredAt", false),
      note: str(body, "note", false),
    });
    sweepRiskChanges(db, deps.clock ? deps.clock() : occurredAt);
    ctx.status = 201;
    ctx.body = { ok: true, occurredAt };
  });

  router.post("/admin/fx-rates", async (ctx) => {
    const body = await readJson(ctx);
    addFxRate(db, {
      fromCurrency: str(body, "fromCurrency")!,
      toCurrency: str(body, "toCurrency")!,
      numerator: int(body, "numerator")!,
      denominator: int(body, "denominator")!,
      effectiveFrom: str(body, "effectiveFrom", false),
    });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.post("/admin/periods/sign", async (ctx) => {
    const body = await readJson(ctx);
    signPeriod(db, {
      contractId: str(body, "contractId")!,
      periodKey: str(body, "periodKey")!,
      note: str(body, "note", false),
      signedAt: str(body, "signedAt", false),
    });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.post("/admin/quota-adjustments", async (ctx) => {
    const body = await readJson(ctx);
    const scope = str(body, "scope")!;
    if (scope !== "day" && scope !== "period") {
      throw new HttpError(400, "invalid_scope", "scope 必须为 day 或 period");
    }
    const at = resolveTime(str(body, "eventTime", false));
    addManualAdjustment(db, {
      contractId: str(body, "contractId")!,
      amount: int(body, "amount")!,
      at,
      scope,
      scopeValue: str(body, "scopeValue")!,
      currency: str(body, "currency")!,
      note: str(body, "note", false),
      approver: str(body, "approver")!,
    });
    ctx.status = 201;
    ctx.body = { ok: true };
  });

  router.post("/admin/exemptions", async (ctx) => {
    const body = await readJson(ctx);
    const scopeType = str(body, "scopeType") ?? "session";
    if (scopeType !== "session" && scopeType !== "day" && scopeType !== "period") {
      throw new HttpError(400, "invalid_scope", "scopeType 必须为 session/day/period");
    }
    const id = grantExemption(db, {
      contractId: str(body, "contractId")!,
      kind: str(body, "kind")! as "overage" | "risk_resume",
      amount: int(body, "amount", false),
      approver: str(body, "approver")!,
      note: str(body, "note", false),
      scope: { type: scopeType, value: str(body, "scopeValue")! },
      eventTime: str(body, "eventTime", false),
    });
    ctx.status = 201;
    ctx.body = { ok: true, exemptionId: id };
  });

  router.get("/admin/reviews", (ctx) => {
    ctx.body = { reviews: listOpenReviews(db) };
  });

  router.post("/admin/reviews/:id/resolve", async (ctx) => {
    const body = await readJson(ctx);
    const action = str(body, "action")!;
    if (action !== "exempt" && action !== "abort") {
      throw new HttpError(400, "invalid_action", "action 必须为 exempt 或 abort");
    }
    const review = resolveReview(db, {
      reviewId: Number(ctx.params.id),
      action,
      approver: str(body, "approver")!,
      note: str(body, "note", false),
      eventTime: str(body, "eventTime", false),
    });
    ctx.body = { ok: true, review };
  });

  // ---- 会话面：准入占用 / 计量 / 结束 / 查询 ------------------------------

  router.post("/sessions/start", async (ctx) => {
    const body = await readJson(ctx);
    const session = startSession(db, {
      requestKey: str(body, "requestKey")!,
      contractId: str(body, "contractId")!,
      siteId: str(body, "siteId")!,
      estimatedAmount: int(body, "estimatedAmount")!,
      currency: str(body, "currency", false),
      vin: str(body, "vin", false),
      vehicleType: str(body, "vehicleType", false),
      accountId: str(body, "accountId", false),
      eventTime: str(body, "eventTime", false),
      holdTtlSeconds: int(body, "holdTtlSeconds", false),
    });
    ctx.status = 201;
    ctx.body = { session };
  });

  router.post("/sessions/:id/meter", async (ctx) => {
    const body = await readJson(ctx);
    const session = applyMeterSegment(db, {
      sessionId: ctx.params.id,
      segmentNo: int(body, "segmentNo")!,
      cumulativeAmount: int(body, "cumulativeAmount")!,
      eventTime: str(body, "eventTime", false),
    });
    ctx.body = { session };
  });

  router.post("/sessions/:id/end", async (ctx) => {
    const body = await readJson(ctx);
    const session = endSession(db, {
      sessionId: ctx.params.id,
      finalAmount: int(body, "finalAmount", false),
      eventTime: str(body, "eventTime", false),
    });
    ctx.body = { session };
  });

  router.get("/sessions/:id", (ctx) => {
    ctx.body = sessionView(db, ctx.params.id);
  });

  router.get("/trace/:key", (ctx) => {
    ctx.body = trace(db, ctx.params.key);
  });

  // ---- 运维：立即执行过期释放与风险扫描（重启时也会自动执行一次） -----------

  router.post("/ops/sweep", (ctx) => {
    const at = deps.clock ? deps.clock() : nowIso();
    const expired = sweepExpiredHolds(db, at);
    const opened = sweepRiskChanges(db, at);
    ctx.body = { ok: true, at, expiredHolds: expired, newReviews: opened };
  });

  app.use(router.routes()).use(router.allowedMethods());
  return app;
}
