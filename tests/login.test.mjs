// 登录页是给人看的门面，不该顺手变成墙上的洞。
// 这一组守的是「加了登录页之后，门没有比原来松」。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
import { buildKernel } from "./build-kernel.mjs";

const source = path => readFile(new URL(path, import.meta.url), "utf8");

test("免鉴权的路径只有登录相关那几条", async () => {
  const proxy = await source("../proxy.ts");
  // 白名单必须是明确列举的常量集合，不能是 startsWith 之类会顺带放行一片的写法。
  const listed = proxy.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(listed, "PUBLIC_PATHS 必须是显式列出的集合");
  const paths = [...listed[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(paths, ["/api/health", "/api/login", "/login"]);
});

test("没票据、Basic 或限定路径的 Cron Bearer，一律进不来", async () => {
  const proxy = await source("../proxy.ts");
  // 两条进门路径都要在，且是「或」关系；缺了 Basic 会打断脚本和健康检查。
  assert.match(proxy, /readTicket\(/);
  assert.match(proxy, /Basic \$\{btoa/);
  assert.match(proxy, /ticketUser === username \|\| basicOk/);
  // 人与普通脚本仍用原有凭据；计划任务只在一个精确路径接受独立密钥。
  assert.match(proxy, /FIELD_ACCESS_USER/);
  assert.match(proxy, /FIELD_ACCESS_PASSWORD/);
  assert.match(proxy, /pathname === "\/api\/cron\/industry-weekly"/);
  assert.match(proxy, /authorization === `Bearer \$\{cronSecret\}`/);
  assert.match(proxy, /ticketUser === username \|\| basicOk \|\| cronOk/);
  assert.doesNotMatch(proxy, /pathname\.startsWith\("\/api\/cron/);
  // 未配置凭据时必须是 503 拒绝，而不是默默放行。
  assert.match(proxy, /if \(!username \|\| !password\) return new NextResponse\([^)]*503/s);
});

test("api 返 401，页面跳登录页", async () => {
  const proxy = await source("../proxy.ts");
  assert.match(proxy, /pathname\.startsWith\("\/api\/"\)\) return unauthorized\(\)/);
  assert.match(proxy, /login\.pathname = "\/login"/);
});

test("登录接口不泄露是用户名错还是密码错", async () => {
  const route = await source("../app/api/login/route.ts");
  // 分开报错等于告诉对方用户名已经猜对了。
  assert.doesNotMatch(route, /用户名不存在|密码不对。".*用户名/s);
  assert.match(route, /用户名或密码不对/);
  // 用户名和密码都要走定长比较——只保护一个就等于没保护。
  const compares = [...route.matchAll(/constantTimeEqual\(/g)];
  assert.ok(compares.length >= 3, `定长比较应同时用于用户名和密码，实际 ${compares.length} 处`);
});

test("票据是 httpOnly 的，且本地 http 下不加 secure", async () => {
  const route = await source("../app/api/login/route.ts");
  assert.match(route, /httpOnly: true/);
  // 本地 http 开发时若无条件加 secure，cookie 存不下来，
  // 症状是「密码对了但一直跳回登录页」。
  assert.match(route, /secure: request\.nextUrl\.protocol === "https:"/);
});

test("改了密码，旧票据立刻失效", async () => {
  const require = createRequire(import.meta.url);
  const outDir = await buildKernel();
  const session = require(`${outDir}/session.js`);
  const now = 1_770_000_000_000;

  const ticket = await session.issueTicket("tokendance", "oldpass", now);
  assert.equal(await session.readTicket(ticket, "oldpass", now), "tokendance");
  // 密钥是从密码派生的，所以换密码即吊销全部旧票据——这是想要的行为。
  assert.equal(await session.readTicket(ticket, "newpass", now), null);
});

test("票据改不动也过得期", async () => {
  const require = createRequire(import.meta.url);
  const outDir = await buildKernel();
  const session = require(`${outDir}/session.js`);
  const now = 1_770_000_000_000;
  const ticket = await session.issueTicket("tokendance", "pw", now);

  // 把用户名改成别人：签名对不上，进不去。
  const [, expires, signature] = ticket.split(".");
  assert.equal(await session.readTicket(`admin.${expires}.${signature}`, "pw", now), null);
  // 把过期时间往后推：同理。
  assert.equal(await session.readTicket(`tokendance.${Number(expires) + 99999}.${signature}`, "pw", now), null);
  // 空票据、垃圾票据都不许放行。
  for (const bad of [undefined, "", "ok", "a.b.c"]) {
    assert.equal(await session.readTicket(bad, "pw", now), null);
  }
  // 过了有效期就是过了。
  assert.equal(await session.readTicket(ticket, "pw", now + 13 * 60 * 60 * 1000), null);
});

test("登录这一层不碰六道门", async () => {
  // 登录只回答「是不是你」，跟「这条判断能不能执行」没有关系。
  const files = await Promise.all([
    source("../lib/session.ts"), source("../app/api/login/route.ts"), source("../app/login/page.tsx"),
  ]);
  for (const file of files) {
    for (const forbidden of ["field-core", "signedOff", "gateState", "executable", "epistemicState", "falsifier"]) {
      assert.ok(!file.includes(forbidden), `登录层不该出现 ${forbidden}`);
    }
  }
});
