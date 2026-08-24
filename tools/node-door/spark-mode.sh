#!/usr/bin/env bash
# spark-mode — the Spark operating modes. Concurrency modes keep gpt-oss-120b;
# vast/swarm swap the model for Qwen3.6-35B (smaller brain, far bigger window).
#   deep:     gpt-oss-120b  -np 1 -c 131072   (131k, one conversation) [default]
#   balanced: gpt-oss-120b  -np 2 -c 131072   (65k x2)
#   wide:     gpt-oss-120b  -np 4 -c 131072   (32k x4)
#   vast:     qwen3.6-35b   -np 1 -c 262144   (262k, one conversation)
#   swarm:    qwen3.6-35b   -np 4 -c 262144   (65k x4, light agents)
#
# THE SCRIPT DOES NOT EXIT UNTIL THE MODEL ACTUALLY SERVES. The old version
# restarted the service and exited at "loading..." — the door reported success
# while the box spent minutes loading (or failed), and no probe from the
# laptop can be trusted through a VPN. Readiness is verified HERE, on the box,
# against localhost, and streamed as progress lines the app shows live.
set -e
U=~/.config/systemd/user/llamacpp.service
GPT="unsloth/gpt-oss-120b-GGUF:F16"
QWEN="unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL"
case "$1" in
  deep)     M=$GPT;  NP=1; C=131072;;
  balanced) M=$GPT;  NP=2; C=131072;;
  wide)     M=$GPT;  NP=4; C=131072;;
  vast)     M=$QWEN; NP=1; C=262144;;
  swarm)    M=$QWEN; NP=4; C=262144;;
  status)   grep -oE -- "-hf [^ ]+ .*-np [0-9]+ -c [0-9]+" "$U"; exit 0;;
  *) echo "usage: spark-mode deep|balanced|wide|vast|swarm|status"; exit 1;;
esac
# IDEMPOTENT: asking for the mode already serving must not restart a healthy
# server — repeated clicks were reloading 65GB for nothing.
if grep -qE -- "-hf $M .*-np $NP -c $C" "$U" && curl -sf -m 3 localhost:30000/health >/dev/null 2>&1; then
  NC=$(curl -sf -m 3 localhost:30000/props 2>/dev/null | grep -oE '"n_ctx": *[0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ "$NC" = "$C" ] || [ "$((NC * NP))" = "$C" ]; then
    echo "already serving: $M (-np $NP -c $C) - nothing to do"
    exit 0
  fi
fi
sed -i -E "s#-hf [^ ]+#-hf $M#; s/-np [0-9]+/-np $NP/; s/-c [0-9]+/-c $C/" "$U"
systemctl --user daemon-reload
systemctl --user restart llamacpp.service
echo "mode=$1 model=$M (-np $NP -c $C => $((C/NP)) tokens/conversation)"
T0=$(date +%s)
DEADLINE=$((T0 + 540))
while true; do
  NOW=$(date +%s); EL=$((NOW - T0))
  if curl -sf -m 3 localhost:30000/health >/dev/null 2>&1; then
    NC=$(curl -sf -m 3 localhost:30000/props 2>/dev/null | grep -oE '"n_ctx": *[0-9]+' | grep -oE '[0-9]+' | head -1)
    # llama.cpp /props reports PER-SLOT n_ctx: pool/NP. Comparing only the
    # pool made every -np>1 mode 'fail' at the deadline with the server up
    # since ~70s. Either reading of the number is acceptance.
    if [ "$NC" = "$C" ] || [ "$((NC * NP))" = "$C" ]; then
      echo "serving: $M (n_ctx $NC) after ${EL}s"
      exit 0
    fi
  fi
  if [ "$NOW" -ge "$DEADLINE" ]; then
    echo "ERROR: $M did not serve within ${EL}s (a first vast/swarm switch downloads weights; re-run the mode to resume)"
    exit 1
  fi
  echo "loading $M - ${EL}s"
  sleep 5
done
