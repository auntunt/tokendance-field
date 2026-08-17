// 登录票据。就一件事：证明这个浏览器输对过一次密码。
//
// 为什么要签名而不是直接写个 cookie=ok：cookie 是客户端能随手改的，
// 不签名等于把门锁挂在门外。这里用 HMAC-SHA256 签「用户名 + 过期时间」，
// 密钥从 FIELD_ACCESS_PASSWORD 派生——密码一改，所有旧票据立刻失效，这是想要的行为。
//
// 跑在 proxy（edge runtime）里，所以只能用 Web Crypto，不能 import node:crypto。
// 也因此全是 async。

export const SESSION_COOKIE = "field_session";
/** 票据有效期。够一天班用，不做「记住我」——这层本来就只是个门，不是账号体系。 */
const TTL_SECONDS = 12 * 60 * 60;

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

/**
 * 定长比较。用 === 比签名会因为提前返回而泄露「前几位对了」，
 * 逐字节异或累加则无论对错都走完全程。
 */
function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 签一张票。返回 `用户名.过期秒.签名`。 */
export async function issueTicket(user: string, secret: string, nowMs: number): Promise<string> {
  const expires = Math.floor(nowMs / 1000) + TTL_SECONDS;
  const body = `${encodeURIComponent(user)}.${expires}`;
  return `${body}.${await hmac(secret, body)}`;
}

/** 验票。签名不对或者过期都返回 null——调用方只关心「能不能进」。 */
export async function readTicket(ticket: string | undefined, secret: string, nowMs: number): Promise<string | null> {
  if (!ticket) return null;
  const cut = ticket.lastIndexOf(".");
  if (cut < 0) return null;
  const body = ticket.slice(0, cut);
  const signature = ticket.slice(cut + 1);
  if (!equalConstantTime(signature, await hmac(secret, body))) return null;

  const [rawUser, rawExpires] = body.split(".");
  const expires = Number(rawExpires);
  if (!Number.isFinite(expires) || expires * 1000 <= nowMs) return null;
  try { return decodeURIComponent(rawUser); } catch { return null; }
}

export const TICKET_MAX_AGE = TTL_SECONDS;
