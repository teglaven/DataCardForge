#!/usr/bin/env bash
# scripts/state-check.sh — STATE.md 闸门（协议见 AGENTS.md §0）
#
#   - STATE.md 缺失 / 缺小节 → exit 2（状态本身坏了，比过期更严重）
#   - 自 STATE.md 最后一次提交起又提交了 >= 阈值 个提交 → exit 1（拦住人，先更新状态）
#   - 否则 exit 0
# 阈值默认 10；`--max-commits N` 或 `DC_STATE_MAX_COMMITS` 覆盖。纯 bash，不依赖 jq / python。
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
cd "$root" || exit 2

max=${DC_STATE_MAX_COMMITS:-10}
case "${1:-}" in
  "") ;;
  --max-commits) max=${2:-} ;;
  --max-commits=*) max=${1#*=} ;;
  *)
    echo "用法: scripts/state-check.sh [--max-commits N]" >&2
    exit 2
    ;;
esac
if ! [[ "$max" =~ ^[0-9]+$ ]]; then
  echo "state-check: 阈值必须是整数（拿到 '$max'）" >&2
  exit 2
fi

if [[ ! -f STATE.md ]]; then
  echo "state-check: 仓库根没有 STATE.md —— 没有状态就没有闸门，按 AGENTS.md §0 补一个。" >&2
  exit 2
fi

missing=0
while IFS= read -r section; do
  if ! grep -qF -- "$section" STATE.md; then
    echo "state-check: STATE.md 缺小节 \`$section\`" >&2
    missing=1
  fi
done <<'SECTIONS'
## 现在是什么
## 上次收工点
## 已冻结契约（改它要新决策）
## 探索中（可推翻，别当承诺）
## 已知缺口（top 5）
## 下次开工第一件事（RESUME）
SECTIONS
[[ $missing -eq 0 ]] || exit 2

base=$(git log -1 --format=%H -- STATE.md 2>/dev/null)
if [[ -z "$base" ]]; then
  echo "STATE.md 新鲜（尚未提交，落后 0 个提交，阈值 $max）"
  exit 0
fi
behind=$(git rev-list --count "$base"..HEAD 2>/dev/null || echo 0)
if (( behind >= max )); then
  echo "state-check: STATE.md 落后 $behind 个提交（阈值 $max）—— 先更新 HEAD / 上次收工点 / RESUME / 已知缺口。" >&2
  exit 1
fi
echo "STATE.md 新鲜（落后 $behind 个提交，阈值 $max）"
exit 0
