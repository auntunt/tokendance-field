import Link from "next/link";

export default function NotFound() {
  return <main className="not-found-page">
    <span>404 / SOURCE NOT FOUND</span>
    <h1>这条路径没有留下证据。</h1>
    <p>返回研究工作台，继续从查询、来源或关系网络里寻找入口。</p>
    <Link href="/">回到 FIELD →</Link>
  </main>;
}
