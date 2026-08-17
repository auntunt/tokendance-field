import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, readTicket } from "./lib/session";

/**
 * 两种进门方式，凭据是同一套：
 *   1. 登录页输密码，拿一张签名票据（人用）
 *   2. Authorization: Basic（脚本、curl、健康检查用）
 * 加登录页没有放宽任何东西——没票据也没 Basic 头，一律进不来。
 */

/** 免鉴权的路径。少一个都进不去：登录页本身要能打开，登录接口要能调。 */
const PUBLIC_PATHS = new Set(["/login", "/api/login", "/api/health"]);

function unauthorized(message = "TokenDance Field requires authentication.") {
  return new NextResponse(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TokenDance Field", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

export async function proxy(request: NextRequest) {
  const username = process.env.FIELD_ACCESS_USER;
  const password = process.env.FIELD_ACCESS_PASSWORD;
  if (!username || !password) return new NextResponse("TokenDance Field access credentials are not configured.", { status: 503 });

  const { pathname } = request.nextUrl;
  const harden = (response: NextResponse) => {
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return response;
  };
  if (PUBLIC_PATHS.has(pathname)) return harden(NextResponse.next());

  const ticketUser = await readTicket(request.cookies.get(SESSION_COOKIE)?.value, password, Date.now());
  const basicOk = request.headers.get("authorization") === `Basic ${btoa(`${username}:${password}`)}`;
  if (ticketUser === username || basicOk) return harden(NextResponse.next());

  // 接口返 401 让前端能处理；页面跳登录页，人不该看见一行裸的报错。
  // next 参数带上原路径，登录完能回到他本来要去的地方。
  if (pathname.startsWith("/api/")) return unauthorized();
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
  return harden(NextResponse.redirect(login));
}

// 整个 _next/ 都不过鉴权，不是只列 static 和 image。原来漏了 _next/webpack-hmr：
// dev 下那条 WebSocket 被这里重定向到 /login，升级握手拿到 307 就断。
//
// 说清楚这条改了什么、没改什么，免得下一个人接着我的猜测走：它止住的是
// 「鉴权层去拦 dev 通道」这件事本身。当时 dev 下 hydration 也不发生，我一度以为
// 是这条造成的——不是。改完 HMR 仍然连不上（那个地址 GET 也 404，是 turbopack
// 与 webpack-hmr 路径不对付，跟鉴权无关），而 dev 的 hydration 照旧不发生；
// 同一份代码 next build && next start 下 hydration 正常、登录和切页都正常。
// 所以 dev 不 hydrate 的根因还没查到，只知道不在这个文件里。
//
// 放开 _next/ 不等于放开数据：App Router 的 RSC 请求走的是页面自己的路径带
// ?_rsc=，仍旧过这里；_next/data 是 Pages Router 的东西，本项目没有。
// 剩下的都是编译产物和 dev 通道，本来就是公开静态资源。
export const config = { matcher: ["/((?!_next/|favicon.svg|og.png|api/health).*)"] };
