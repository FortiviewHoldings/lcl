# .lcl.engine

**The engine is everything that is not someone else's engine, runtime, or model.**

That is the definition, stated by the operator, and it draws the line exactly
where it belongs. llama.cpp is not the engine — it is a runtime we drive.
qwen3-4b is not the engine — it is a model we load. Tesseract, ffmpeg,
KiCad's ERC, ngspice, FreeCAD: instruments, all of them, and all replaceable.
The engine is the layer that decides — what runs, what it may touch, what it
knows, whether its output is true, and what happens next. Remove every
third-party binary from this machine and the engine is what remains: the part
we wrote, the part that ships, the part that is *ours*.

## Why a top layer is the product

A 4-billion-parameter model is not intelligent the way a frontier model is
intelligent. It guesses confidently, calls tools clumsily, and forgets what it
cannot fit in context. The wager of this project is that most of the distance
between a small local model and a frontier one is not weights — it is
*harness*. A frontier assistant is strong because something above the raw
model routes, grounds, checks, retries, and refuses. That something is
buildable. It does not need a datacenter. It needs to be written well, once,
and it runs offline forever.

Concretely, the engine already converts weakness into competence in ways a
bare model cannot:

- A model that would invent a fuse rating is forced through **capture →
  OCR cross-check → confidence flags → human verification** before a redline.
- A model that would hallucinate a specification detail answers through **retrieval →
  cross-encoder reranking → citation**, grounded in indexed specification
  pages, with the page number attached.
- A model that cannot read a 6-pixel scan is handed the page by a **vision
  pass measured verbatim-accurate**, at 35 seconds a page, on this laptop's
  GPU.
- A model that would happily `rm -rf` runs behind a **deny-by-default policy
  kernel** whose EXECUTE and OFFENSIVE floors are welded shut.
- A model that fits in memory only sometimes is placed by a **load planner
  that plans against the peak**, because this machine froze once and the
  lesson stuck.

None of that intelligence lives in a gguf. All of it survives a model swap.

## The layers

| Layer | What it owns | Where |
|---|---|---|
| **Policy kernel** | Deny-by-default capability grants, classification, per-tool floors, append-only audit | `policy/` |
| **Agent loop** | Turn orchestration, tool parsing/rescue, backstops for observed small-model failures, clarify-vs-act | `core/agent.js` |
| **Runtime supervision** | Engine lifecycle, load planning against physical memory, crash recovery, model ladder & fallback | `core/engine.js`, `core/loadPlanner.js`, `core/paths.js` |
| **Knowledge** | Indexing (text, OCR, raster, deep-read), dedupe, integrity, retrieval, reranking, grounding with citations | `core/knowledge.js`, `core/embedIndex.js`, `core/reranker.js`, `core/ocrTools.js`, `core/pdfRaster.js` |
| **Fabrication** | Schematic generation judged by ERC, CAD judged by geometry checks, SPICE solved not described, capture→redline | `core/schematic.js`, `core/cad.js`, `core/spice.js`, `core/redline.js` |
| **Safety rails** | Write guards (placeholder/prompt-leak), secret egress guard, sandbox, script staging for human approval | `core/fsTools.js`, `core/secretGuard.js`, `core/sandbox.js`, `core/scriptRunner.js` |
| **Memory of work** | Durable task ledger with interruption honesty, real progress (n/total), activity feed | `core/tasks.js` |
| **How it works with you** | Facts derived from how sessions actually went, one readable file each; the app's chosen tone, applied to the model and to the app's own conversational lines — never to a diagnostic | `core/tailor.js`, `core/voice.js` |
| **What a conversation may do** | Per-session, inherit-unless-set permissions resolved fresh on every check, including whether a profile of the operator may travel to a paid endpoint | `core/sessionPerms.js` |

The rule every layer obeys: **an external oracle beats self-assessment**.
KiCad's ERC judges schematics, not the model's opinion of them. The gate
judges OCR, not hope. Measured numbers judge load plans. Where no oracle
exists, the engine says so and routes the judgment to the human.

## What is borrowed, and what it would cost to replace

Runtimes (`runtimes/`): llama.cpp (MIT), stable-diffusion.cpp (MIT).
Models (`models/`): open-weight ggufs, each with its license in the registry.
Tools (`tools/`): ffmpeg, tesseract, and the KiCad/FreeCAD/ngspice installs it
detects. Every one is a commodity: pin the interface, and any of them can be
swapped without the engine noticing. That is the point of the line.

## The direction

The engine grows toward doing more *deciding* per token the model generates:
routing tasks to the model that earns them, spending extra passes (critic,
verifier, second opinion) exactly where confidence is low, compressing what it
learned about this user's machines and methods into retrievable, citable
knowledge — shipped knowledge for the world's proven physics and engineering,
local knowledge for what belongs only to this operator. The models will keep
changing underneath. The engine is the part that compounds.

## One rule about what leaves

Anything the engine works out **about the operator** — as opposed to what they
asked — reaches a paid endpoint only if that conversation was given permission
to send it. It is off by default, like every other permission, and the switch
says plainly what it costs either way.

This is written down because it was got wrong once, in a way worth remembering:
`tailor.js` stated outright that what it learned could never leave the machine,
and the module really did call nothing. But `promptBlock()` was concatenated
into the system prompt, and a system prompt travels wherever the turn does — so
a profile of the operator was in the request body of every cloud-driven turn,
under a comment swearing it could not be. **A module that sends nothing is not
the same as a fact that goes nowhere.** The claim now lives in one named,
exported function (`agent.tailoringBlockFor`) so it can be exercised rather than
asserted, and `tests/no-bleed.js` holds the neighbouring rule: nothing about the
operator's other work appears anywhere in this product's text or examples.
