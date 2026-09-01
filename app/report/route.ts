import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * 把生成好的情报报告接进产品界面。
 *
 * 为什么是 route handler 而不是一个 React 页面：report-html.ts 产出的是一份
 * **完整的 HTML 文档**（自带 <head>、内联样式、内联脚本），设计目的就是能单文件
 * 发出去。把它塞进 React 组件树要么得拆掉那份自包含性，要么得用
 * dangerouslySetInnerHTML 把 <html> 嵌进 <body>，两条都不对。原样 serve 最诚实。
 *
 * 鉴权不用自己写：proxy.ts 的 matcher 覆盖除 _next/ 与 /api/health 之外的一切，
 * 这条路径照样要过票据或 Basic。别把它加进 PUBLIC_PATHS——
 * 报告里有 149 处法定披露事实和人名，不是公开页面。
 */
export const dynamic = "force-dynamic";

/**
 * 报告目录。不能直接用 process.cwd()/reports。
 *
 * standalone 产物的 cwd 是 .next/standalone，而 build 时会把项目根的 reports/
 * **拷一份**进去。用 cwd 的话，production 下读到的是 build 那一刻的快照：
 * 之后每次 npm run report:build 写的都是项目根那份，服务这边看不到，
 * 除非重新 next build。那就等于「定期重跑」出不来新数据，这条路由白接。
 *
 * 所以从 cwd 往上找第一个含 reports/ 的目录，让 dev 和 standalone 都落到
 * 项目根那一份上。FIELD_REPORTS_DIR 留给部署时目录结构不同的情况。
 */
function reportsDir(): string {
  const override = process.env.FIELD_REPORTS_DIR;
  if (override) return resolve(override);
  let dir = process.cwd();
  for (let up = 0; up < 4; up += 1) {
    // .next/standalone 里那份拷贝要跳过——它是快照，不是活的产出目录。
    const candidate = resolve(dir, "reports");
    if (existsSync(candidate) && !dir.includes(`${sep}.next${sep}`) && !dir.endsWith(`${sep}.next`)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "reports");
}

const REPORTS_DIR = reportsDir();
/** 只认 build-report.ts 的命名，避免把 history/ 里的快照或别的东西当报告发出去。 */
const REPORT_NAME = /^fde-report-\d{4}-\d{2}-\d{2}\.html$/;

/** 最新一份报告。按文件名排序而不是 mtime：名字里带的是数据日期，
 *  mtime 会因为拷贝、同步、touch 而变，数据日期不会。 */
function latestReport(): { file: string; date: string } | null {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter(name => REPORT_NAME.test(name)).sort();
  const file = files.at(-1);
  return file ? { file, date: file.slice("fde-report-".length, -".html".length) } : null;
}

/** 还没生成过报告时给一页能照着做的说明，而不是 404。
 *  空白页会让人以为是坏了，实际只是这条流水线还没跑过。 */
function notBuiltYet(): Response {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>情报报告尚未生成</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.7 -apple-system, "SF Pro SC", "PingFang SC", system-ui, sans-serif;
    background: #fbfaf9; color: #1c1917; padding: 24px; }
  @media (prefers-color-scheme: dark) { body { background: #17140f; color: #f2efe9; } }
  .box { max-width: 34rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
    background: rgba(128,128,128,.16); padding: .15em .45em; border-radius: 4px; }
  a { color: inherit; }
</style></head><body><div class="box">
<h1>情报报告尚未生成</h1>
<p>报告是一次性产出的单文件 HTML，需要先跑一次生成脚本：</p>
<p><code>npm run report:build</code></p>
<p>跑完刷新本页即可。生成的文件同时留在 <code>reports/</code> 下，可以直接发给别人。</p>
<p><a href="/">← 回情报台</a></p>
</div></body></html>`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export async function GET() {
  const latest = latestReport();
  if (!latest) return notBuiltYet();

  const path = resolve(REPORTS_DIR, latest.file);
  // 拼好路径后再校验它确实落在 reports/ 里。文件名已经过白名单正则，
  // 这一层是纵深防御：万一以后允许用参数指定报告，这里不至于变成任意读文件。
  if (!path.startsWith(REPORTS_DIR)) return notBuiltYet();

  let html: string;
  try {
    html = readFileSync(path, "utf8");
  } catch {
    return notBuiltYet();
  }

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 报告会重跑覆盖，缓存住就会看到旧数据。
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow, noarchive",
      // 让人知道看的是哪一版数据，不必去翻文件名。
      "x-report-date": latest.date,
      "last-modified": statSync(path).mtime.toUTCString(),
    },
  });
}
