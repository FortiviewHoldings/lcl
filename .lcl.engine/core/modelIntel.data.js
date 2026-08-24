"use strict";
/* Curated model catalog, 2026-08 - editorial ratings grounded in published
 * benchmarks and arena standings; every figure overridable by the operator. */
module.exports = {
  "asOf": "2026-08",
  "note": "editorial capability ratings informed by published 2026 benchmarks and arena standings; rates in USD per million tokens; all of it overridable by the operator",
  "providers": [
    {
      "id": "xai",
      "label": "Grok",
      "baseUrl": "api.x.ai",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "anthropic",
      "label": "Anthropic",
      "baseUrl": "api.anthropic.com",
      "connectUrl": "api.anthropic.com/v1",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "openai",
      "label": "OpenAI",
      "baseUrl": "api.openai.com",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "google",
      "label": "Google",
      "baseUrl": "generativelanguage.googleapis.com",
      "keyNeeded": true,
      "kind": "api",
      "connectUrl": "generativelanguage.googleapis.com/v1beta/openai"
    },
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "baseUrl": "api.deepseek.com",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "mistral",
      "label": "Mistral",
      "baseUrl": "api.mistral.ai",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "groq",
      "label": "Groq",
      "baseUrl": "api.groq.com",
      "keyNeeded": true,
      "kind": "api",
      "connectUrl": "api.groq.com/openai/v1"
    },
    {
      "id": "together",
      "label": "Together AI",
      "baseUrl": "api.together.xyz",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "fireworks",
      "label": "Fireworks",
      "baseUrl": "api.fireworks.ai",
      "keyNeeded": true,
      "kind": "api",
      "connectUrl": "api.fireworks.ai/inference/v1"
    },
    {
      "id": "openrouter",
      "label": "OpenRouter",
      "baseUrl": "openrouter.ai/api",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "deepinfra",
      "label": "DeepInfra",
      "baseUrl": "api.deepinfra.com",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "zen",
      "label": "OpenCode Zen (GO)",
      "baseUrl": "opencode.ai/zen",
      "keyNeeded": true,
      "kind": "api"
    },
    {
      "id": "ollama",
      "label": "Ollama (self-hosted)",
      "baseUrl": "localhost:11434",
      "keyNeeded": false,
      "kind": "local"
    },
    {
      "id": "llamacpp",
      "label": "llama.cpp (self-hosted)",
      "baseUrl": "localhost:8080",
      "keyNeeded": false,
      "kind": "local"
    }
  ],
  "models": [
    {
      "id": "xai/grok-4.5",
      "label": "Grok 4.5",
      "provider": "xai",
      "blurb": "xAI flagship with configurable reasoning effort, strongest on agentic, vision, and document work.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 9,
        "drawing": 0,
        "speed": 5,
        "agentic": 9
      },
      "context": 500000,
      "rate": {
        "in": 2,
        "out": 6
      },
      "openWeights": false
    },
    {
      "id": "xai/grok-4.3",
      "label": "Grok 4.3",
      "provider": "xai",
      "blurb": "Previous xAI flagship, still a strong long-context generalist at a lower rate.",
      "caps": {
        "code": 8,
        "reasoning": 8,
        "vision": 8,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 1000000,
      "rate": {
        "in": 1.25,
        "out": 2.5
      },
      "openWeights": false
    },
    {
      "id": "xai/grok-4.1-fast",
      "label": "Grok 4.1 Fast",
      "provider": "xai",
      "blurb": "Very cheap 2M-context workhorse for high-volume retrieval, routing, and summarization.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 7,
        "drawing": 0,
        "speed": 9,
        "agentic": 7
      },
      "context": 2000000,
      "rate": {
        "in": 0.2,
        "out": 0.5
      },
      "openWeights": false
    },
    {
      "id": "xai/grok-build-0.1",
      "label": "Grok Build 0.1",
      "provider": "xai",
      "blurb": "Coder-tuned Grok built for fast agentic editing loops in IDEs and CLIs.",
      "caps": {
        "code": 9,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 8,
        "agentic": 9
      },
      "context": 256000,
      "rate": {
        "in": 1,
        "out": 2
      },
      "openWeights": false
    },
    {
      "id": "xai/grok-imagine",
      "label": "Grok Imagine",
      "provider": "xai",
      "blurb": "xAI image and short-video generator; priced per image rather than per token.",
      "caps": {
        "code": 0,
        "reasoning": 2,
        "vision": 6,
        "drawing": 8,
        "speed": 7,
        "agentic": 0
      },
      "context": 32768,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "anthropic/claude-fable-5",
      "label": "Claude Fable 5",
      "provider": "anthropic",
      "blurb": "Anthropic's top model and current number one on the overall text arena; deepest reasoning and agentic coding available.",
      "caps": {
        "code": 10,
        "reasoning": 10,
        "vision": 9,
        "drawing": 0,
        "speed": 4,
        "agentic": 10
      },
      "context": 500000,
      "rate": {
        "in": 10,
        "out": 50
      },
      "openWeights": false
    },
    {
      "id": "anthropic/claude-opus-5",
      "label": "Claude Opus 5",
      "provider": "anthropic",
      "blurb": "Frontier-class reasoning and coding at half the flagship price; the sane default for hard work.",
      "caps": {
        "code": 10,
        "reasoning": 10,
        "vision": 9,
        "drawing": 0,
        "speed": 5,
        "agentic": 10
      },
      "context": 500000,
      "rate": {
        "in": 5,
        "out": 25
      },
      "openWeights": false
    },
    {
      "id": "anthropic/claude-sonnet-5",
      "label": "Claude Sonnet 5",
      "provider": "anthropic",
      "blurb": "Balanced daily driver with excellent agentic coding and a 1M context window.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 8,
        "drawing": 0,
        "speed": 7,
        "agentic": 9
      },
      "context": 1000000,
      "rate": {
        "in": 3,
        "out": 15
      },
      "openWeights": false
    },
    {
      "id": "anthropic/claude-haiku-4-5",
      "label": "Claude Haiku 4.5",
      "provider": "anthropic",
      "blurb": "Fast, cheap Claude that still handles tools and subagent work credibly.",
      "caps": {
        "code": 7,
        "reasoning": 7,
        "vision": 7,
        "drawing": 0,
        "speed": 9,
        "agentic": 7
      },
      "context": 200000,
      "rate": {
        "in": 1,
        "out": 5
      },
      "openWeights": false
    },
    {
      "id": "openai/gpt-5.6-sol",
      "label": "GPT-5.6 Sol",
      "provider": "openai",
      "blurb": "OpenAI flagship tuned for complex agentic, scientific, and security work.",
      "caps": {
        "code": 9,
        "reasoning": 10,
        "vision": 9,
        "drawing": 0,
        "speed": 5,
        "agentic": 9
      },
      "context": 1050000,
      "rate": {
        "in": 5,
        "out": 30
      },
      "openWeights": false
    },
    {
      "id": "openai/gpt-5.6-terra",
      "label": "GPT-5.6 Terra",
      "provider": "openai",
      "blurb": "Balanced mid-tier that matches the old GPT-5.5 at a production-friendly price.",
      "caps": {
        "code": 8,
        "reasoning": 9,
        "vision": 8,
        "drawing": 0,
        "speed": 7,
        "agentic": 8
      },
      "context": 1050000,
      "rate": {
        "in": 2,
        "out": 12
      },
      "openWeights": false
    },
    {
      "id": "openai/gpt-5.6-luna",
      "label": "GPT-5.6 Luna",
      "provider": "openai",
      "blurb": "Fastest, cheapest GPT tier for classification, routing, and bulk extraction.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 7,
        "drawing": 0,
        "speed": 9,
        "agentic": 6
      },
      "context": 1050000,
      "rate": {
        "in": 0.2,
        "out": 1.2
      },
      "openWeights": false
    },
    {
      "id": "openai/gpt-5.5",
      "label": "GPT-5.5",
      "provider": "openai",
      "blurb": "Prior OpenAI flagship, still served and still near the top of the text arena cluster.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 8,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 400000,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "openai/gpt-image-1.5",
      "label": "GPT Image 1.5",
      "provider": "openai",
      "blurb": "OpenAI's quality-leading image generator with best-in-class prompt following and text rendering.",
      "caps": {
        "code": 0,
        "reasoning": 3,
        "vision": 7,
        "drawing": 10,
        "speed": 4,
        "agentic": 0
      },
      "context": 32768,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "google/gemini-3.1-pro",
      "label": "Gemini 3.1 Pro",
      "provider": "google",
      "blurb": "Google's frontier model and the strongest all-round multimodal reader of video, audio, and PDFs.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 10,
        "drawing": 0,
        "speed": 6,
        "agentic": 9
      },
      "context": 1048576,
      "rate": {
        "in": 2,
        "out": 12
      },
      "openWeights": false
    },
    {
      "id": "google/gemini-3.6-flash",
      "label": "Gemini 3.6 Flash",
      "provider": "google",
      "blurb": "Production Flash tier with surprisingly strong reasoning and agentic performance for the price.",
      "caps": {
        "code": 8,
        "reasoning": 8,
        "vision": 9,
        "drawing": 0,
        "speed": 8,
        "agentic": 8
      },
      "context": 1048576,
      "rate": {
        "in": 1.5,
        "out": 7.5
      },
      "openWeights": false
    },
    {
      "id": "google/gemini-3.5-flash-lite",
      "label": "Gemini 3.5 Flash-Lite",
      "provider": "google",
      "blurb": "Cheap high-throughput tier for bulk multimodal work where latency matters most.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 8,
        "drawing": 0,
        "speed": 9,
        "agentic": 6
      },
      "context": 1048576,
      "rate": {
        "in": 0.3,
        "out": 2.5
      },
      "openWeights": false
    },
    {
      "id": "google/gemini-2.5-flash-lite",
      "label": "Gemini 2.5 Flash-Lite",
      "provider": "google",
      "blurb": "Legacy bargain-basement tier; the cheapest hosted way to burn through a million documents.",
      "caps": {
        "code": 5,
        "reasoning": 5,
        "vision": 7,
        "drawing": 0,
        "speed": 10,
        "agentic": 4
      },
      "context": 1048576,
      "rate": {
        "in": 0.1,
        "out": 0.4
      },
      "openWeights": false
    },
    {
      "id": "google/gemini-3-pro-image",
      "label": "Nano Banana Pro",
      "provider": "google",
      "blurb": "Google's high-end image model, the reference for photo-real edits and in-image text; priced per image.",
      "caps": {
        "code": 0,
        "reasoning": 4,
        "vision": 8,
        "drawing": 9,
        "speed": 5,
        "agentic": 0
      },
      "context": 32768,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "google/gemini-3-flash-image",
      "label": "Nano Banana 2",
      "provider": "google",
      "blurb": "Fast, cheap image generation and editing at roughly a cent per image.",
      "caps": {
        "code": 0,
        "reasoning": 3,
        "vision": 7,
        "drawing": 8,
        "speed": 8,
        "agentic": 0
      },
      "context": 32768,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "deepseek/deepseek-v4",
      "label": "DeepSeek V4",
      "provider": "deepseek",
      "blurb": "1.6T-parameter MIT-licensed MoE with a 1M context that leads raw SWE-bench Verified among open models.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 0,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 1000000,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "deepseek/deepseek-v4-flash",
      "label": "DeepSeek V4 Flash",
      "provider": "deepseek",
      "blurb": "Absurdly cheap 1M-context workhorse for everyday coding and text tasks.",
      "caps": {
        "code": 7,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 9,
        "agentic": 7
      },
      "context": 1000000,
      "rate": {
        "in": 0.14,
        "out": 0.28
      },
      "openWeights": true
    },
    {
      "id": "deepseek/deepseek-r2",
      "label": "DeepSeek R2",
      "provider": "deepseek",
      "blurb": "Open-weights deliberate reasoner; slow but formidable on math, proofs, and hard analysis.",
      "caps": {
        "code": 8,
        "reasoning": 10,
        "vision": 0,
        "drawing": 0,
        "speed": 3,
        "agentic": 7
      },
      "context": 164000,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "mistral/mistral-large-3",
      "label": "Mistral Large 3",
      "provider": "mistral",
      "blurb": "Apache-licensed 675B MoE flagship, Europe's strongest open generalist.",
      "caps": {
        "code": 8,
        "reasoning": 8,
        "vision": 7,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 256000,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "mistral/mistral-medium-3.5",
      "label": "Mistral Medium 3.5",
      "provider": "mistral",
      "blurb": "128B open-weight mid-tier with a strong cost-to-quality ratio for enterprise text work.",
      "caps": {
        "code": 7,
        "reasoning": 7,
        "vision": 6,
        "drawing": 0,
        "speed": 7,
        "agentic": 7
      },
      "context": 131072,
      "rate": {
        "in": 0.4,
        "out": 2
      },
      "openWeights": true
    },
    {
      "id": "mistral/mistral-small-4",
      "label": "Mistral Small 4",
      "provider": "mistral",
      "blurb": "Small multimodal model that is easy to self-host and nearly free to run hosted.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 5,
        "drawing": 0,
        "speed": 8,
        "agentic": 5
      },
      "context": 131072,
      "rate": {
        "in": 0.1,
        "out": 0.3
      },
      "openWeights": true
    },
    {
      "id": "groq/moonshotai/kimi-k2-instruct",
      "label": "Kimi K2 (Groq)",
      "provider": "groq",
      "blurb": "Moonshot's agentic MoE served on LPUs, giving frontier-adjacent tool use at very high speed.",
      "caps": {
        "code": 8,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 9,
        "agentic": 8
      },
      "context": 131072,
      "rate": {
        "in": 1,
        "out": 3
      },
      "openWeights": true
    },
    {
      "id": "groq/llama-3.3-70b-versatile",
      "label": "Llama 3.3 70B (Groq)",
      "provider": "groq",
      "blurb": "Proven general 70B at roughly 400 tokens per second; a dependable fast tier.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 0,
        "drawing": 0,
        "speed": 9,
        "agentic": 6
      },
      "context": 131072,
      "rate": {
        "in": 0.59,
        "out": 0.79
      },
      "openWeights": true
    },
    {
      "id": "groq/llama-3.1-8b-instant",
      "label": "Llama 3.1 8B Instant (Groq)",
      "provider": "groq",
      "blurb": "Cheapest and fastest hosted option, north of 800 tokens per second for trivial tasks.",
      "caps": {
        "code": 4,
        "reasoning": 4,
        "vision": 0,
        "drawing": 0,
        "speed": 10,
        "agentic": 3
      },
      "context": 131072,
      "rate": {
        "in": 0.05,
        "out": 0.08
      },
      "openWeights": true
    },
    {
      "id": "groq/openai/gpt-oss-120b",
      "label": "GPT-OSS 120B (Groq)",
      "provider": "groq",
      "blurb": "OpenAI's open-weights reasoner on LPUs; strong reasoning per dollar at interactive speed.",
      "caps": {
        "code": 7,
        "reasoning": 8,
        "vision": 0,
        "drawing": 0,
        "speed": 9,
        "agentic": 7
      },
      "context": 131072,
      "rate": {
        "in": 0.15,
        "out": 0.6
      },
      "openWeights": true
    },
    {
      "id": "groq/openai/gpt-oss-20b",
      "label": "GPT-OSS 20B (Groq)",
      "provider": "groq",
      "blurb": "Tiny open reasoner for latency-critical chains where every millisecond counts.",
      "caps": {
        "code": 6,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 10,
        "agentic": 5
      },
      "context": 131072,
      "rate": {
        "in": 0.1,
        "out": 0.5
      },
      "openWeights": true
    },
    {
      "id": "together/Qwen/Qwen3.5-397B-A17B-Instruct",
      "label": "Qwen3.5 397B",
      "provider": "together",
      "blurb": "Alibaba's open flagship, the top open-weights SWE-bench score with only 17B active parameters.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 6,
        "drawing": 0,
        "speed": 6,
        "agentic": 9
      },
      "context": 262144,
      "rate": {
        "in": 0.54,
        "out": 3.4
      },
      "openWeights": true
    },
    {
      "id": "together/moonshotai/Kimi-K2.6-Instruct",
      "label": "Kimi K2.6",
      "provider": "together",
      "blurb": "Open multimodal Kimi that reads text, image, and video with solid tool use in a 256K window.",
      "caps": {
        "code": 8,
        "reasoning": 8,
        "vision": 7,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 262144,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "together/meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
      "label": "Llama 4 Maverick",
      "provider": "together",
      "blurb": "Meta's larger Llama 4 MoE, a cheap multimodal generalist with a very long window.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 7,
        "drawing": 0,
        "speed": 7,
        "agentic": 6
      },
      "context": 524288,
      "rate": {
        "in": 0.27,
        "out": 0.85
      },
      "openWeights": true
    },
    {
      "id": "fireworks/accounts/fireworks/models/qwen3-coder-480b-a35b-instruct",
      "label": "Qwen3 Coder 480B",
      "provider": "fireworks",
      "blurb": "Coder-specialized giant MoE that excels at repository-scale agentic editing.",
      "caps": {
        "code": 9,
        "reasoning": 8,
        "vision": 0,
        "drawing": 0,
        "speed": 6,
        "agentic": 9
      },
      "context": 262144,
      "rate": {
        "in": 0.45,
        "out": 1.8
      },
      "openWeights": true
    },
    {
      "id": "fireworks/accounts/fireworks/models/deepseek-v4",
      "label": "DeepSeek V4 (Fireworks)",
      "provider": "fireworks",
      "blurb": "US-hosted serving of the open V4 weights for teams that cannot call the first-party API.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 0,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 1000000,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "openrouter/moonshotai/kimi-k3",
      "label": "Kimi K3",
      "provider": "openrouter",
      "blurb": "Moonshot's open-weights frontier model and the current leader of the Frontend Code Arena.",
      "caps": {
        "code": 10,
        "reasoning": 9,
        "vision": 7,
        "drawing": 0,
        "speed": 5,
        "agentic": 9
      },
      "context": 262144,
      "rate": {
        "in": 3,
        "out": 15
      },
      "openWeights": true
    },
    {
      "id": "openrouter/z-ai/glm-5.2",
      "label": "GLM-5.2",
      "provider": "openrouter",
      "blurb": "Zhipu's open flagship that tops the open-weights intelligence index and shines in agent harnesses.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 5,
        "drawing": 0,
        "speed": 6,
        "agentic": 9
      },
      "context": 262144,
      "rate": {
        "in": 1.4,
        "out": 4.4
      },
      "openWeights": true
    },
    {
      "id": "openrouter/qwen/qwen3.7-max",
      "label": "Qwen3.7 Max",
      "provider": "openrouter",
      "blurb": "Alibaba's closed-weight reasoning-native flagship with a 1M context window.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 7,
        "drawing": 0,
        "speed": 6,
        "agentic": 8
      },
      "context": 1000000,
      "rate": {
        "in": 2.5,
        "out": 7.5
      },
      "openWeights": false
    },
    {
      "id": "openrouter/black-forest-labs/flux-2-pro",
      "label": "FLUX 2 Pro",
      "provider": "openrouter",
      "blurb": "Black Forest Labs' image flagship, tied for the top image-arena Elo; priced per image.",
      "caps": {
        "code": 0,
        "reasoning": 2,
        "vision": 5,
        "drawing": 10,
        "speed": 6,
        "agentic": 0
      },
      "context": 4096,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "deepinfra/meta-llama/Llama-4-Scout-17B-16E-Instruct",
      "label": "Llama 4 Scout",
      "provider": "deepinfra",
      "blurb": "Small Llama 4 MoE for cheap multimodal bulk work over very long inputs.",
      "caps": {
        "code": 5,
        "reasoning": 5,
        "vision": 6,
        "drawing": 0,
        "speed": 8,
        "agentic": 5
      },
      "context": 327680,
      "rate": {
        "in": 0.08,
        "out": 0.3
      },
      "openWeights": true
    },
    {
      "id": "deepinfra/Qwen/Qwen3.6-35B-A3B-Instruct",
      "label": "Qwen3.6 35B-A3B",
      "provider": "deepinfra",
      "blurb": "Sparse coder that hits 73 percent SWE-bench Verified while activating only 3B parameters per token.",
      "caps": {
        "code": 8,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 9,
        "agentic": 7
      },
      "context": 262144,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "deepinfra/black-forest-labs/FLUX-2-dev",
      "label": "FLUX 2 dev",
      "provider": "deepinfra",
      "blurb": "Open-weights FLUX for image generation you can also run on your own GPU; priced per image.",
      "caps": {
        "code": 0,
        "reasoning": 2,
        "vision": 4,
        "drawing": 8,
        "speed": 6,
        "agentic": 0
      },
      "context": 4096,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "zen/grok-code",
      "label": "Grok Code (Zen)",
      "provider": "zen",
      "blurb": "Coding-agent model routed through the OpenCode Zen gateway, bundled with the GO subscription.",
      "caps": {
        "code": 8,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 9,
        "agentic": 8
      },
      "context": 256000,
      "rate": null,
      "openWeights": false
    },
    {
      "id": "zen/qwen3-coder",
      "label": "Qwen3 Coder (Zen)",
      "provider": "zen",
      "blurb": "Zen-served open coder tier for agentic editing without managing your own provider keys.",
      "caps": {
        "code": 8,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 8,
        "agentic": 8
      },
      "context": 262144,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "ollama/qwen3-coder:30b",
      "label": "Qwen3 Coder 30B (local)",
      "provider": "ollama",
      "blurb": "Best local coding value; a coder-tuned sparse 30B that runs well on a single consumer GPU.",
      "caps": {
        "code": 8,
        "reasoning": 6,
        "vision": 0,
        "drawing": 0,
        "speed": 6,
        "agentic": 7
      },
      "context": 262144,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "ollama/glm-5.2",
      "label": "GLM-5.2 (local)",
      "provider": "ollama",
      "blurb": "The open intelligence-index leader self-hosted, if you have serious multi-GPU hardware.",
      "caps": {
        "code": 9,
        "reasoning": 9,
        "vision": 5,
        "drawing": 0,
        "speed": 3,
        "agentic": 9
      },
      "context": 131072,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "ollama/llama4:scout",
      "label": "Llama 4 Scout (local)",
      "provider": "ollama",
      "blurb": "Local multimodal generalist with modest hardware needs and a permissive-enough license.",
      "caps": {
        "code": 5,
        "reasoning": 5,
        "vision": 6,
        "drawing": 0,
        "speed": 5,
        "agentic": 5
      },
      "context": 131072,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "ollama/deepseek-r2:32b",
      "label": "DeepSeek R2 Distill 32B (local)",
      "provider": "ollama",
      "blurb": "R2 reasoning distilled into a 32B you can run on one 24GB GPU; slow but genuinely thoughtful offline.",
      "caps": {
        "code": 7,
        "reasoning": 8,
        "vision": 0,
        "drawing": 0,
        "speed": 4,
        "agentic": 6
      },
      "context": 131072,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "ollama/gpt-oss:20b",
      "label": "GPT-OSS 20B (local)",
      "provider": "ollama",
      "blurb": "OpenAI's small open reasoner, a snappy offline default for laptops with 16GB of memory.",
      "caps": {
        "code": 6,
        "reasoning": 7,
        "vision": 0,
        "drawing": 0,
        "speed": 7,
        "agentic": 5
      },
      "context": 131072,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "llamacpp/qwen3-coder-30b-a3b-instruct-gguf",
      "label": "Qwen3 Coder 30B GGUF",
      "provider": "llamacpp",
      "blurb": "GGUF build of the local coding favorite for llama.cpp servers and CPU-heavy boxes.",
      "caps": {
        "code": 8,
        "reasoning": 6,
        "vision": 0,
        "drawing": 0,
        "speed": 5,
        "agentic": 7
      },
      "context": 262144,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "llamacpp/gpt-oss-120b-gguf",
      "label": "GPT-OSS 120B GGUF",
      "provider": "llamacpp",
      "blurb": "The strongest open reasoner that still fits a single 80GB card in its native MXFP4 quantization.",
      "caps": {
        "code": 7,
        "reasoning": 8,
        "vision": 0,
        "drawing": 0,
        "speed": 4,
        "agentic": 6
      },
      "context": 131072,
      "rate": null,
      "openWeights": true
    },
    {
      "id": "llamacpp/mistral-small-4-24b-gguf",
      "label": "Mistral Small 4 GGUF",
      "provider": "llamacpp",
      "blurb": "Compact open multimodal model that quantizes cleanly for fully offline vision-and-text work.",
      "caps": {
        "code": 6,
        "reasoning": 6,
        "vision": 5,
        "drawing": 0,
        "speed": 6,
        "agentic": 5
      },
      "context": 131072,
      "rate": null,
      "openWeights": true
    }
  ]
};
