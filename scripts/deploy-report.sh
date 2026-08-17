#!/usr/bin/env bash
# 生成报告并推到线上。
#
# 为什么需要这个脚本：报告 HTML 走 docker volume，不在镜像里
# （见 docker-compose.prod.yml 的注释）。这意味着改了 lib/report-html.ts
# 之后，重新构建镜像没有任何用——线上读的是 volume 里那个文件。
# 必须「本机重新生成 → docker cp 上去」两步都做。
#
# 这两步分开手动执行时很容易只做前一半：本机看着是新的，线上还是旧的。
# 所以合成一条命令，并且最后一定校验线上返回的 x-report-date。
#
# 用法：
#   scripts/deploy-report.sh              # 生成 + 推送 + 校验
#   scripts/deploy-report.sh --skip-build # 只推送已有报告（渲染器没改时用）
#
# 凭据：从环境变量读，不写在脚本里。
#   FIELD_SSH_HOST（默认 Liyibin@8.141.121.22）
#   FIELD_SSH_PASS（必填，sudo 和 ssh 共用这一个）
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="${FIELD_SSH_HOST:-Liyibin@8.141.121.22}"
CONTAINER="tokendance-field-1"
REMOTE_DIR="/home/Liyibin/tokendance-field"
PORT=8021

if [[ -z "${FIELD_SSH_PASS:-}" ]]; then
  echo "缺 FIELD_SSH_PASS。用法：FIELD_SSH_PASS='...' scripts/deploy-report.sh" >&2
  exit 1
fi
command -v sshpass >/dev/null || { echo "缺 sshpass：brew install sshpass" >&2; exit 1; }

SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

if [[ $SKIP_BUILD -eq 0 ]]; then
  echo "▸ 本机生成报告"
  node scripts/build-report.mjs
fi

# 取最新一份，而不是按当天日期拼文件名：重跑失败时宁可推一份旧的上去，
# 也不要因为文件不存在而静默什么都没推。
FILE=$(ls -1 reports/fde-report-*.html | sort | tail -1)
DATE=$(basename "$FILE" | sed 's/fde-report-\(.*\)\.html/\1/')
# 变量必须用 ${} 包起来：紧跟其后的全角「（」会被 bash 当成变量名的一部分，
# 报 unbound variable。半角标点没这个问题，所以很容易漏。
echo "▸ 待推送：${FILE}（$(wc -c <"$FILE" | tr -d ' ') 字节）"

SSH=(sshpass -p "$FIELD_SSH_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$HOST")

echo "▸ 上传到服务器 /tmp"
sshpass -p "$FIELD_SSH_PASS" scp -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
  "$FILE" "$HOST:/tmp/" >/dev/null

echo "▸ 拷进容器 volume"
"${SSH[@]}" "echo '$FIELD_SSH_PASS' | sudo -S docker cp /tmp/$(basename "$FILE") $CONTAINER:/reports/ 2>/dev/null && rm -f /tmp/$(basename "$FILE")"

# 校验。只看「文件在不在」不够——route.ts 挑的是最新那一份，
# 而且响应头会回报它实际读到的日期。以那个为准。
echo "▸ 校验线上实际返回的版本"
"${SSH[@]}" "cd $REMOTE_DIR && \
  ENVTXT=\$(echo '$FIELD_SSH_PASS' | sudo -S cat ./.env 2>/dev/null) && \
  U=\$(printf '%s\n' \"\$ENVTXT\" | sed -n 's/^FIELD_ACCESS_USER=//p' | tr -d '\r') && \
  P=\$(printf '%s\n' \"\$ENVTXT\" | sed -n 's/^FIELD_ACCESS_PASSWORD=//p' | tr -d '\r') && \
  unset ENVTXT && \
  curl -s -D- -o /tmp/chk.html -u \"\$U:\$P\" http://127.0.0.1:$PORT/report 2>/dev/null \
    | grep -iE '^(HTTP|x-report-date)'; \
  unset U P; \
  rm -f /tmp/chk.html" 2>&1 | grep -v '^\[sudo\]'

echo "✓ 完成。线上应为 ${DATE}，刷新 infoget.tokenplaza.cc/report 查看。"
