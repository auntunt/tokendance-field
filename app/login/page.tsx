"use client";

import { useRef, useState } from "react";

/**
 * 登录页。功能上等价于原来的浏览器 Basic 弹窗，只是长得像自己家的东西，
 * 而且退得出去——Basic 弹窗一旦输了就没法在界面里登出。
 *
 * 输入框是非受控的（defaultValue + ref），提交时才读值。原来用 useState 受控，
 * 结果是：页面 HTML 先到，hydration 后到，这中间敲进去的字 React 不知道，
 * 一 hydrate 就被 state 里的空串盖掉，人看着框里有字、按钮却一直是灰的。
 * autoFocus 更是明摆着请人早敲。按钮也不再按 state 判空——只在提交中禁用，
 * 空值交给 required 兜。
 */
export default function LoginPage() {
  const userRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const user = userRef.current?.value ?? "";
    const password = passwordRef.current?.value ?? "";
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, password }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) { setError(data.error || "登录失败"); return; }

      // 用 location.assign 而不是 router.push：票据是 httpOnly cookie，
      // 客户端路由不会重新过 proxy，会带着旧的鉴权状态渲染。整页跳转最稳。
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next && next.startsWith("/") ? next : "/");
    } catch {
      setError("连不上服务端");
    } finally { setBusy(false); }
  }

  return (
    <main className="login-page">
      {/* method="post" 是没有 JS 时的兜底：默认的 GET 会把密码贴到地址栏和访问日志里。 */}
      <form className="login-card" method="post" onSubmit={submit}>
        <div className="login-brand"><span>F</span><b>FIELD / EVIDENCE OS</b></div>
        <h1>进入研究工作台</h1>
        <p className="login-lede">这里保存来源正文、事实主张和查询关系。访问凭据由部署环境统一管理。</p>

        <label htmlFor="login-user">用户名
          <input id="login-user" name="user" ref={userRef} defaultValue="" required
            autoComplete="username" autoFocus />
        </label>
        <label htmlFor="login-password">密码
          <input id="login-password" name="password" type="password" ref={passwordRef} defaultValue="" required
            autoComplete="current-password" />
        </label>

        {error && <p className="login-error" role="alert">● {error}</p>}

        <button type="submit" className="primary-action" disabled={busy}>
          {busy ? "正在核验…" : "进入工作台"}
        </button>
        <small className="login-foot">会话保留 12 小时；API 健康检查继续使用服务端认证。</small>
      </form>
    </main>
  );
}
