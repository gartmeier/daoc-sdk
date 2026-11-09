#!/bin/bash
# Pair rounds: two groups a round and the third sits out (no script runs for it), rotating through the three pairings,
# so every fight is one realm against one and rounds of a pairing compare with each other.
# Each pair patrols a ring round its spot (settings.opponent, sdk/group/keeps.ts pairs), going round opposite ways, and
# stops on dry ground (stayDry, on by default). Hibernia and Midgard's spot is on Hibernia's bank: Midgard swims across
# once, and the pack waits until it is ashore. The other two pairs still meet on their river.
#
#   FIRST=<0-2> bash groups/pair-rounds.sh [rounds=3] [seconds=600] [more flags for both groups]
#
# Before each round all three groups go home to their portal keep (groups/go-home.ts), so every round starts from the
# same place. Nobody runs: a losing group fights to its last member (FIGHT below), then releases, rests at its keep
# and comes again. FIRST picks the pairing to start with (0 hibernia-midgard, 1 midgard-camelot, 2 camelot-hibernia).
#
# Every group must already be in Thidranki (groups/<g>/battleground.ts) with its clients running. Each report's
# "Water:" line has "Fights with both other realms: N": in a pair round it should be 0 (the 'pair' finding says otherwise).
cd /c/Users/joshu/Code/daoc-sdk
declare -A REALM=([camelot]=albion [midgard]=midgard [hibernia]=hibernia)
PAIRS=("hibernia midgard" "midgard camelot" "camelot hibernia")
# No retreat or fall back for roaming (never outnumbered by 99), and the pack neither goes home broken nor refuses with few.
FIGHT="--retreat.margin=99 --pack.minTogether=1 --pack.minPack=1"
rounds=${1:-3}
seconds=${2:-600}
first=${FIRST:-0}
if [ $# -ge 2 ]; then shift 2; else shift $#; fi
for i in $(seq "$first" $((first + rounds - 1))); do
  read -r a b <<< "${PAIRS[$((i % 3))]}"
  n=$(ls groups/$a/runs/ groups/$b/runs/ | grep -oE 'rvr-pair-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1); n=$((n + 1))
  echo "going home before round $n, $(date +%H:%M)"
  for g in camelot midgard hibernia; do bun groups/go-home.ts $g > groups/$g/runs/go-home-$n.log 2>&1 & done
  wait
  for g in camelot midgard hibernia; do echo "  $g: $(grep -oE '"message": ?"[^"]*"|is home|success.*' groups/$g/runs/go-home-$n.log | tail -1)"; done
  echo "pair round $n: $a vs $b, main $(git rev-parse --short HEAD), start $(date +%H:%M)"
  bun groups/$a/rvr.ts "$seconds" --opponent=${REALM[$b]} $FIGHT "$@" > groups/$a/runs/rvr-pair-$n.log 2>&1 &
  bun groups/$b/rvr.ts "$seconds" --opponent=${REALM[$a]} $FIGHT "$@" > groups/$b/runs/rvr-pair-$n.log 2>&1 &
  wait
  for g in $a $b; do
    f=$(ls -t groups/$g/runs/*.md | head -1)
    echo "  $g: $(grep -m1 '^RvR:' "$f" | grep -oE '[0-9]+ player kills, [0-9]+ deaths to players') | $(grep -m1 '^Water:' "$f" | cut -c8-) | pre-empted $(grep -c Pre-empted groups/$g/runs/rvr-pair-$n.log)"
  done
done
