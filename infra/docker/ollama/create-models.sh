#!/bin/sh
# Runs inside the ollama container (`pnpm infra:llm:models`). Pulls each
# Modelfile's base Qwen2.5-VL weights and builds the context-size variant the
# app selects with LLM_LOCAL_MODEL (default qwen2.5vl-3b-48k).
set -e
for f in /modelfiles/Modelfile.*; do
  name="${f##*/Modelfile.}"
  base=$(sed -n 's/^FROM //p' "$f")
  echo "==> $name (from $base)"
  ollama pull "$base"
  ollama create "$name" -f "$f"
done
ollama list
