import Router from "@koa/router";
import type { Context, Next } from "koa";
import { ServiceError } from "./errors.js";
import type { ClearingService } from "./service.js";

async function readJson(context: Context): Promise<any> {
  if (context.method === "GET") return {};
  const text = await collectBody(context);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError("invalid_json", 400, "请求体不是合法 JSON");
  }
}

function collectBody(context: Context): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    context.req.setEncoding("utf8");
    context.req.on("data", (chunk: string) => { data += chunk; });
    context.req.on("end", () => resolve(data));
    context.req.on("error", reject);
  });
}

export function createRouter(service: ClearingService): Router {
  const router = new Router();

  router.get("/health", (context) => {
    context.body = { status: "ok", service: "charging-clearing" };
  });

  // ---- 管理端 ----
  router.post("/admin/contracts", async (c) => {
    const b = await readJson(c);
    c.body = service.createContract(b.contractId, b.partnerId);
    c.status = 201;
  });

  router.post("/admin/contracts/:id/versions", async (c) => {
    const b = await readJson(c);
    c.body = service.publishVersion(c.params.id, b);
    c.status = 201;
  });

  router.post("/admin/contracts/:id/suspension", async (c) => {
    const b = await readJson(c);
    c.body = service.setContractSuspended(c.params.id, !!b.suspend, b.reason, b.occurredAt);
  });

  router.post("/admin/guarantees", async (c) => {
    const b = await readJson(c);
    c.body = service.addGuarantee(b.guaranteeId, b.contractId, Number(b.amount), b.currency);
    c.status = 201;
  });

  router.post("/admin/guarantees/:id/withdraw", async (c) => {
    const b = await readJson(c);
    c.body = service.withdrawGuarantee(c.params.id, b.reason);
  });

  router.post("/admin/sites/:id/eligibility", async (c) => {
    const b = await readJson(c);
    c.body = service.setSiteEligibility(c.params.id, !!b.qualified, b.reason, b.occurredAt);
  });

  router.post("/admin/fx-rates", async (c) => {
    const b = await readJson(c);
    c.body = service.publishFxRate({
      baseCurrency: b.baseCurrency,
      quoteCurrency: b.quoteCurrency,
      rate: Number(b.rate),
      effectiveAt: b.effectiveAt,
    });
    c.status = 201;
  });

  router.post("/admin/exemptions", async (c) => {
    const b = await readJson(c);
    c.body = service.addExemption({
      contractId: b.contractId,
      currency: b.currency,
      sessionId: b.sessionId,
      dayKey: b.dayKey,
      periodKey: b.periodKey,
      extraDaily: b.extraDaily != null ? Number(b.extraDaily) : undefined,
      extraPeriod: b.extraPeriod != null ? Number(b.extraPeriod) : undefined,
      approver: b.approver,
      reason: b.reason,
    });
    c.status = 201;
  });

  router.get("/admin/reviews", (c) => {
    c.body = { reviews: service.listPendingReviews() };
  });

  router.post("/admin/reviews/:id/resolve", async (c) => {
    const b = await readJson(c);
    if (b.status !== "waived" && b.status !== "rejected") {
      throw new ServiceError("invalid_review_status", 400, "status 必须为 waived 或 rejected");
    }
    c.body = service.resolveReview(c.params.id, b.status, b.resolver, b.note);
  });

  router.post("/admin/sweep", (c) => {
    c.body = service.runSweepers();
  });

  // ---- 会话 ----
  router.post("/sessions/start", async (c) => {
    const b = await readJson(c);
    c.body = service.startSession({
      sessionId: b.sessionId,
      idempotencyKey: b.idempotencyKey,
      contractId: b.contractId,
      siteId: b.siteId,
      accountId: b.accountId,
      vehicleModel: b.vehicleModel,
      amount: Number(b.amount),
      currency: b.currency,
      startedAt: b.startedAt,
      holdTtlSeconds: b.holdTtlSeconds != null ? Number(b.holdTtlSeconds) : undefined,
      approvedBy: b.approvedBy,
    });
    c.status = 201;
  });

  router.post("/sessions/:id/fragments", async (c) => {
    const b = await readJson(c);
    c.body = service.addFragment(c.params.id, {
      fragmentId: b.fragmentId,
      seq: Number(b.seq),
      observedAt: b.observedAt,
      amount: Number(b.amount),
      currency: b.currency,
    });
    c.status = 201;
  });

  router.post("/sessions/:id/end", async (c) => {
    const b = await readJson(c);
    c.body = service.endSession(c.params.id, {
      amount: Number(b.amount),
      currency: b.currency,
      endedAt: b.endedAt,
    });
  });

  router.get("/sessions/:id/trace", (c) => {
    c.body = service.traceSession(c.params.id);
  });

  // ---- 结算 ----
  router.post("/settlements/:id/sign", async (c) => {
    const b = await readJson(c);
    c.body = service.signSettlement(c.params.id, b.signedBy);
  });

  return router;
}

export function errorHandler() {
  return async (context: Context, next: Next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof ServiceError) {
        context.status = err.status;
        context.body = { error: { code: err.code, message: err.message, details: err.details ?? null } };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      context.status = 500;
      context.body = { error: { code: "internal_error", message } };
      context.app.emit("error", err, context);
    }
  };
}
