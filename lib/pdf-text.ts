// PDF 正文提取。只服务一个具体场景：交易所法定披露公告。
//
// 为什么需要它：实测抓了 7 篇公开报道，主体里有一半不是法人（品牌名、园区名、
// 项目名、设备名），关系类型也常被硬塞进最近的一类。根因是新闻通稿写的是
// 关系的展示面。换成交易所披露后同一个抽取器的表现完全不同——
// 一份儒意电影的关联交易公告，8 个主体全是法人全称，关系类型原文明写。
// 差别不在抽取器，在语料：披露规则强制写全称、强制说明利益冲突。
//
// 而两家交易所的公告详情页都直接重定向到 PDF，浏览器 innerText 拿到 0 字。
// 所以要接 PDF，否则这个数据源用不了。
//
// 为什么用外部 pdftotext 而不是 JS 库：pdf-parse 解包 21MB，
// 而 pdftotext（poppler）在这份 4 页公告上解出 7965 字，
// 连表格里的金额和注册资本都完整。装一个系统包比背一个 21MB 依赖划算，
// 缺了也能明确报错让人去装，不至于静默降级。
//
// 已知损失：PDF 里的表格会被拆成竖排文本，行列对应关系丢失。
// 抽取器读得懂字面内容，但"哪个关联方对应哪个金额"这种跨列信息会错。
// 这是 PDF 转文本的固有代价，没有在这一层解决——
// 真要解决得做版面分析，那是另一个量级的工程。
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 判断该 URL 是否指向 PDF。交易所把扩展名写成大写 .PDF，所以不能只匹配小写。 */
export function looksLikePdf(url: string, contentType?: string) {
  if (contentType?.toLowerCase().includes("application/pdf")) return true;
  try { return /\.pdf$/i.test(new URL(url).pathname); } catch { return false; }
}

/** 把 PDF 字节解成纯文本。
 *
 *  写临时文件而不是走 stdin：pdftotext 需要随机读取（PDF 的
 *  交叉引用表在文件末尾），管道喂不进去。
 *  finally 里无条件删目录，失败路径也不留残留。 */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "field-pdf-"));
  const src = join(dir, "in.pdf");
  const out = join(dir, "out.txt");
  try {
    await writeFile(src, bytes);
    // -enc UTF-8 是必须的：默认编码会把中文公告解成乱码。
    // -layout 保留一些横向布局，对关联交易金额表比纯流式好一点。
    await run("pdftotext", ["-enc", "UTF-8", "-layout", src, out], { timeout: 30_000 });
    const text = await readFile(out, "utf8");
    // 只做换行规范化，**不合并连续空格**。
    //
    // 这里原来有一句 .replace(/[ \t]+/g, " ")，它把 -layout 刚刚建立的列对齐
    // 全部抹平了——等于先花力气保留版面再自己删掉。后果不是「文本变短」，
    // 而是港股主要股东表抽不出来：那张表靠「百分比列的右边界对齐」来判断
    // 续行属于哪个股东（同一股东按内资股/H股分两行，第二行名字列是空的）。
    // 空格一合并，所有列位置都归零，续行认不出来，5.23% 那种 H 股持股会静默丢失。
    // 实测同一份 PDF：合并空格 576K 字符、抽出 0 个股东；不合并 880K 字符、抽出 10 个。
    //
    // 行尾空格还是要去掉的——它不承载列信息，留着只会干扰引语比对。
    return text
      .replace(/\r/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(msg)) throw new Error("未安装 pdftotext（poppler）。macOS: brew install poppler");
    throw new Error(`PDF 解析失败：${msg.slice(0, 200)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
