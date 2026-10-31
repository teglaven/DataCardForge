#!/usr/bin/env bash
# find-term.sh —— 只定位，不判断：在仓库受跟踪文件里找词，吐「文件:行号: 命中行」。
# 动机：靠 read 逐个文件找词既慢又花上下文；先让脚本给出坐标，再决定读哪几行。
#
# 用法：
#   bash scripts/find-term.sh 回归卡
#   bash scripts/find-term.sh 回归卡 新建回归卡 linear-regression   # 多个词，各出一段
#   TERM_INCLUDE='*.ts,*.tsx' bash scripts/find-term.sh 回归卡      # 限定文件类型
#   TERM_LIMIT=200 bash scripts/find-term.sh 回归卡                 # 每词最多 N 行（默认 60）
#
# 只搜 git 跟踪的文件（node_modules / build / 产物天然排除）；
# 未跟踪的新文件用 TERM_UNTRACKED=1 追加进来。
set -uo pipefail

LIMIT="${TERM_LIMIT:-60}"
INCLUDE="${TERM_INCLUDE:-}"
UNTRACKED="${TERM_UNTRACKED:-0}"

[ "$#" -gt 0 ] || { echo "用法: bash scripts/find-term.sh <词> [更多词...]" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "需要 git" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "不在 git 仓库里" >&2; exit 2; }

if [ -n "$INCLUDE" ]; then
  # git grep 的 pathspec 用逗号分隔不行，这里转成 -- '*.ts' '*.tsx'
  mapfile -t GLOBS < <(printf '%s' "$INCLUDE" | tr ',' '\n' | sed '/^$/d')
  PATHS=(-- "${GLOBS[@]}")
else
  PATHS=(-- .)
fi

total=0
for term in "$@"; do
  echo "=== $term"
  # git grep: 跟踪文件；-n 行号；-I 跳过二进制；-F 纯文本（词里可能有 . / : 等）
  out="$(git grep -n -I -F -e "$term" "${PATHS[@]}" 2>/dev/null)"
  if [ "$UNTRACKED" = "1" ]; then
    extra="$(git ls-files -o --exclude-standard -z | xargs -0 -r grep -n -I -F -e "$term" -- 2>/dev/null)"
    [ -n "$extra" ] && out="$(printf '%s\n%s' "$out" "$extra" | sed '/^$/d')"
  fi
  if [ -z "$out" ]; then
    echo "  (无命中)"
    continue
  fi
  n="$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
  total=$((total + n))
  # 按文件聚合：文件 -> 行号列表
  printf '%s\n' "$out" | awk -F: '
    { file=$1; rest=substr($0, length($1)+2); line=$2; text=substr($0, length($1)+length($2)+3);
      if (file != prev) { if (prev != "") printf "  %s  (%d 处)\n", prev, cnt; printf "  %s\n", file; prev=file; cnt=0 }
      cnt++; printf "    L%-5s %s\n", line, text }
    END { if (prev != "") printf "  %s  (%d 处)\n", prev, cnt }' | head -n "$((LIMIT + 40))"
  echo "  命中 $n 行 / 文件 $(printf '%s\n' "$out" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')"
done
echo "总计 $total 行"
