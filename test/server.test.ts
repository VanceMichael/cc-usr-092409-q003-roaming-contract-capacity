import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.ts";

test("应用装配了 Koa 中间件", () => {
  const app = createApp();
  assert.ok(app.middleware.length > 0);
});
