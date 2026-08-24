#!/usr/bin/env bash
# train-lcl — bake the .lcl instruction corpus into a gpt-oss-20b LoRA, on this
# box, end to end: pause the fleet for headroom, train, restart the fleet,
# name the adapter. Every step prints; the door streams the lines live.
set -u
FACTORY=~/factoryEnv/bin/llamafactory-cli
YAML=~/training/gptoss20b-lora.yaml
DATA=~/training/datasets/instruction-pairs.jsonl
OUT=~/training/out/gptoss20b-lcl-lora

if [ ! -x "$FACTORY" ]; then
  echo "ERROR: LLaMA-Factory is not installed on this box (factoryEnv missing)"
  exit 1
fi
if [ ! -f "$YAML" ]; then
  echo "ERROR: training config missing ($YAML)"
  exit 1
fi
if [ ! -s "$DATA" ]; then
  echo "ERROR: no dataset staged - send the corpus first"
  exit 1
fi
PAIRS=$(wc -l < "$DATA")
echo "dataset: $PAIRS pairs staged"

echo "pausing the vLLM fleet for training headroom..."
sudo docker stop vllm-server >/dev/null 2>&1 || true

echo "training gpt-oss-20b LoRA (rank 16)..."
"$FACTORY" train "$YAML" 2>&1 | grep --line-buffered -E "epoch|loss|it/s|steps|Error|error|Traceback" | while read -r l; do echo "train: $l"; done
CODE=${PIPESTATUS[0]}

echo "restarting the vLLM fleet..."
sudo docker start vllm-server >/dev/null 2>&1 || echo "WARN: fleet restart failed - start vllm-server by hand"

if [ "$CODE" -ne 0 ]; then
  echo "ERROR: training exited $CODE"
  exit 1
fi
if [ ! -f "$OUT/adapter_model.safetensors" ]; then
  echo "ERROR: training finished but no adapter landed at $OUT"
  exit 1
fi
SIZE=$(du -h "$OUT/adapter_model.safetensors" | cut -f1)
echo "ADAPTER: $OUT/adapter_model.safetensors ($SIZE)"
exit 0
