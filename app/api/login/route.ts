// 登录与登出。凭据仍然是 FIELD_ACCESS_USER / FIELD_ACCESS_PASSWORD——
// 这一层只是把「每次请求都带 Basic 头」换成「输一次密码，发一张签名票据」，
// 没有新增账号，也没有放宽任何东西。
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, TICKET_MAX_AGE, issueTicket } from "../../../lib/session";

/** 输错密码时统一停一下。挡不住有备而来的人，但能让顺手猜密码变得不划算。 */
const WRONG_PASSWORD_DELAY_MS = 400;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: NextRequest) {
  const user = process.env.FIELD_ACCESS_USER;
  const password = process.env.FIELD_ACCESS_PASSWORD;
  if (!user || !password) return NextResponse.json({ error: "服务端没有配置访问凭据，登录不了。" }, { status: 503 });

  let body: { user?: string; password?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "请求格式不对。" }, { status: 400 }); }

  // 用户名也定长比较：两者都参与判定，就不该只有一个走安全路径。
  const ok = constantTimeEqual(String(body.user ?? ""), user)
    && constantTimeEqual(String(body.password ?? ""), password);
  if (!ok) {
    await new Promise(resolve => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
    // 不说清是用户名错还是密码错——分开说等于告诉对方用户名猜对了。
    return NextResponse.json({ error: "用户名或密码不对。" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, user });
  response.cookies.set(SESSION_COOKIE, await issueTicket(user, password, Date.now()), {
    httpOnly: true,            // JS 读不到，少一条 XSS 偷票据的路
    sameSite: "lax",
    // 只在 HTTPS 下加 secure：本地 http 开发时加了 secure，cookie 根本存不下来，
    // 会表现成「密码对了但一直跳回登录页」。
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: TICKET_MAX_AGE,
  });
  return response;
}

/** 登出：把票据删掉就行，服务端没有会话表可清。 */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
