import Koa from "koa";
import Router from "@koa/router";

export function createApp() {
  const app = new Koa();
  const router = new Router();
  router.get("/health", (context) => { context.body = { status: "ok", service: "charging-clearing" }; });
  app.use(router.routes()).use(router.allowedMethods());
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? "8080");
  createApp().listen(port, "0.0.0.0");
}
