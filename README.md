<div align="center">

# .lcl

### An AI workbench that runs on your machine, with the network switched off.

![runs on your machine](https://img.shields.io/badge/runs-on%20your%20machine-1f6feb)
![network off by default](https://img.shields.io/badge/network-off%20by%20default-2ea043)
![no account required](https://img.shields.io/badge/account-not%20required-2ea043)
![platform Windows](https://img.shields.io/badge/platform-Windows-555)
![license MIT](https://img.shields.io/badge/license-MIT-555)

**[Try the lite version in your browser](https://fortiviewholdings.github.io/lcl/)** · **[Download the latest release](https://github.com/FortiviewHoldings/lcl/releases/latest)**

</div>

---

If you have used a chat assistant in a browser, you know roughly half of what this is. The other
half is the part that matters: this one runs on your own hardware, reads your own files, drives
your own instruments, and does not phone anyone. You can unplug the network entirely and it keeps
working. That is not a privacy mode you toggle. It is the default state, and the online parts are
the ones you have to switch on.

## The one-paragraph version

Install it, and you get a desktop app with a chat window. Behind that window is a language model
running as a local process on your own machine, a library of reference documents it can cite, and
more than sixty tools it can use: read a folder, edit a file, run a script, read a scanned PDF,
look at a photo, transcribe audio, generate an image, identify or flash a dev board, query a
spreadsheet with SQL, search a shelf of reference books offline. Every one of those tools is off
until you allow it, and the ones that can change something — your files, a board, the machine —
cannot run without you approving that exact action, that one time.

## What is actually in the box

The installer is around 1.5 GB because it brings its own runtime for everything above. No Python to
install, no Docker, no API key required, no account.

| What ships | What it gives you |
|---|---|
| **llama.cpp** | runs language models locally — on your integrated GPU where a model fits, on CPU otherwise |
| **stable-diffusion.cpp** | generates images locally (SDXL-Turbo) |
| **whisper.cpp** | speech to text, including live dictation into the chat box |
| **Tesseract** | reads text off scanned pages and photographs, offline |
| **ffmpeg** | audio and video inspection and conversion |
| **qpdf, ImageMagick, SQLite, Graphviz** | real PDF surgery, image work, SQL over your data files, diagrams |
| **A reference library** | a prebuilt **offline search index** over ~64 public-domain and openly-licensed volumes, every hit cited by document and page |
| **One model, ready to go** | a small coding model (`qwen2.5-coder-1.5b`), so it answers the moment it installs |

Two honest caveats about that table. First, the reference library ships as the **index** — the
searchable, cited passages — not the source PDFs; the originals (Maxwell's *Treatise on Electricity
and Magnetism*, Ellingson's *Electromagnetics*, the DOE handbooks on thermodynamics and reactor
theory, Planck, CODATA, the US Standard Atmosphere, and about sixty more) are re-fetchable rather
than bundled, so opening an original you have not downloaded needs the network on. Second, a few
heavier capabilities lean on professional apps you install yourself: **3D modelling** needs FreeCAD,
and **schematic capture, ERC, export and circuit simulation** need KiCad (whose bundled ngspice does
the solving). Those are not in the installer — the tools that use them simply do not appear until
the app is present. Diagram drawing (Graphviz) *is* bundled and works out of the box.

## Where the thinking happens: four places, one list

Most tools like this pick one. This one lets you choose per conversation, and it never hides which
you are talking to.

1. **This machine.** A model file on your disk, running on your own hardware. Free, private, always
   available, and slower on big models.
2. **Another machine you own.** A workstation or a GPU box on your network or across the house.
   Same privacy story, much more speed, because the hardware is still yours.
3. **An API vendor.** Anthropic, OpenAI, DeepInfra, and so on. Fast and capable, costs money, and
   your text leaves the building. Requires you to turn the network on first, deliberately.
4. **A GPU rented by the hour.** Its own category on purpose, because it looks exactly like option
   two and is not. The permission card for it says so in plain words: *a rented machine, not
   yours* — and it never suppresses the cost meter or relaxes the secrets warning.

The model picker groups them exactly like that. Your own hardware always sorts above someone
else's, and a rented box never gets folded in with a machine you own.

## What it can do, grouped by what could go wrong

Everything is deny-by-default. The list below is not a feature brag, it is a permission map.

**Reads your workspace** (runs on its own, once you link a folder)
List files, read text and code, extract real text from PDFs with page citations, OCR scanned pages,
look at images with a vision model, search by meaning rather than keyword, run read-only SQL over
CSV and SQLite data, check a schematic. Your reference libraries work the same way — after you link
one (including the built-in one) to the session, answers cite the document and page; a session with
nothing linked searches nothing.

**Changes files** (runs, then shows you the diff, and it is revertable)
Write and edit files, edit PDFs and images, draw diagrams and schematics, redline a drawing, build
a 3D model, transcribe audio to a file. Deleting a file asks first, always, and keeps a backup.

**Runs commands** (asks first, by default)
A script you approve runs with your own file permissions inside your linked folder — with your API
keys stripped from its environment — or in a scrubbed scratch folder when no folder is linked.
A safety inspector refuses whole categories outright (disk wipe, credential theft, privilege
escalation, remote-code-download-and-run) before a script is ever shown. Turn on *"only run scripts
inside a real sandbox"* and approved scripts are forced into a Windows low-integrity box instead — a
kernel-enforced boundary, not a promise in a comment — which is also where the disposable-folder
code checker (`sandbox_test`) always runs. It can also serve a folder on localhost for you to
preview, and scaffold, build and run a React app — but it never deploys or pushes; publishing stays
your hand.

**Touches the network** (off until you turn it on)
Web search runs and then tells you afterward; fetching a URL, researching a topic, and asking a
cloud or reasoning model all ask first, with the destination on the card. Internal, loopback,
private and cloud-metadata addresses are blocked, and a credential read from your files is refused
egress no matter how the network dial is set.

**Acts on connected hardware** (asks first — the exact command is shown)
Reading hardware is read-only: `inspect_devices` lists what is plugged into USB and serial and can
passively listen to a board. But the app can also **act** on a board when you approve it — flash
firmware (`flash_device`, via arduino-cli, PlatformIO or a `.uf2` copy), send and read serial
(`serial_write`, `serial_read`), reset a board to capture its boot log (`serial_read reset`,
`board_identify`), back up its entire flash before you overwrite it (`backup_firmware`), and install
a board toolchain onto your PC (`install_toolchain`). Every one of these is welded to ask-first: you
see the exact command before anything runs on the board or the machine.

**Security work**
Dependency audits, config review, secret scanning (working tree and git history), code and
crypto/auth review are ordinary read-only tools. Port scanning, fuzzing and exploit validation
exist, but stay completely unavailable until you create a time-boxed engagement naming one
authorized host. That is a deliberate wall.

## The parts you will not find elsewhere

**It can read its own source and patch itself — on a source checkout.** You give a patch session an
allowlist of paths; it works in an isolated git worktree, and nothing lands until a review passes:
a secrets scan of every added line, caps on files and diff size, and a welded list of files that can
never be touched no matter what anyone asks — the policy kernel, the secret scanner, the agent loop,
the guards, and the whole test suite are on it, because a patch that edits the guard defeats the
guard. Review proposes, you run the one merge command yourself. (The packaged build ships compiled,
without git or sources, so self-patching is a developer-checkout capability, not something the
installed app does.)

**It can describe a codebase without leaking it.** Point it at a private repository and it extracts
the shape — file counts, languages, layering, depth, fan-out, test ratio, provably-public
dependencies — while generalising away every name that could identify the project or the customer.
It shows you what it withheld before it keeps anything, and if it had to stop early it says so
rather than presenting a partial picture as a whole one.

**It knows what it cannot do.** A failed probe is reported as a failed probe. If the device scan
cannot run, it says the scan did not run; it does not report an empty bench. That distinction sounds
small until it costs you an afternoon.

**It tells you what a model costs before you commit.** It measures the machine, works out whether a
model actually fits in RAM, and refuses with an exact shortfall figure rather than starting a load
that would take the desktop down with it — and a watchdog kills and swaps down to a smaller model if
memory ever runs out mid-run.

**You can reach a node you own from your phone.** If you link a compute node and open its door, that
node's AI — plus its live stats and named setup recipes — becomes reachable from any network,
including a phone's browser, through one token-authenticated HTTPS endpoint (published over a
Tailscale Funnel, so it works even under a full-tunnel VPN). The door fronts that *node*, not the
desktop app, and its token is a real capability — it can run the node's setup recipes — so treat it
like one. A dedicated phone client is on the roadmap.

## Who it is for

**Anyone doing bench or field work.** Instruments on a table, a laptop with no reliable internet,
and a stack of vendor manuals nobody wants to read. It identifies what is plugged in, can flash or
talk to a board, reads the spec PDF, cites the page, and does not need a signal.

**Anyone with documents they cannot upload.** Contracts, drawings, patient or customer records,
anything under an NDA. It reads them locally. Nothing leaves unless you turn the network on and
approve the specific call.

**Anyone who writes code and wants a second reader** that can survey a repository, run a snippet in a
sandbox, and — on a source checkout — propose patches that have to pass review before they land.

**Anyone tired of not knowing where their text went.** Every conversation says which machine
answered it, what it cost, and what permission it used.

## Honest limits

- **Windows only** today.
- **Local inference is slower than a cloud model.** It uses your integrated GPU where a model fits
  and CPU otherwise; a 9B model on a laptop is genuinely useful, and it is not GPT-class. That is
  what options two, three and four exist for.
- **It installs with one small model.** The others are downloads you choose, from ~1 GB to ~5 GB.
- **8 GB of RAM is the floor**, 16 GB is comfortable, 32 GB runs everything.
- **CAD and EDA need apps you install yourself.** 3D modelling needs FreeCAD; schematic capture,
  ERC, export and circuit simulation need KiCad (with its bundled ngspice). Diagram drawing
  (Graphviz) is bundled.
- **Self-patching needs a developer checkout** with git and sources; the installed build cannot do it.
- **The roadmap below is a direction, not an inventory.** It names things that are planned, not
  built. Everything above this line is what actually ships today.

## System requirements & the full capability map

This section is generated from the real sources — the model registry and the policy engine — by
`devtools/capability-map.js`, so it cannot drift from what the app actually does.

<!-- CAPABILITY-MAP:START -->
<!-- generated by devtools/capability-map.js — do not edit by hand -->

### System requirements

| | Minimum | Comfortable | To run everything |
|---|---|---|---|
| **RAM in the machine** | 8 GB | 16 GB | 32 GB |
| **Free when you launch** | 2.9 GB | 5.7 GB | 7.2 GB |
| **Disk for models** | 6.0 GB | 25.0 GB | 60.0 GB |
| **CPU** | any x64 | 8 cores | 16+ cores |
| **GPU** | not required | optional | optional |
| **Network** | never required | never required | never required |
| **Largest model** | qwen2.5-coder-1.5b-q4 | qwen3-vl-4b-instruct | glm-4-9b-0414-iq4xs |

How it is calculated: weights at the CPU load peak (x1) + KV cache at q8 + compute buffers + 1.4 GB kept for the operating system (offloading to an integrated GPU needs more, not less).

**GPU note.** On integrated graphics, GPU memory is the same physical RAM, so offloading copies the weights twice and needs more, not less. These models run on CPU here.


### Models
| Model | Size | Role | Good at | RAM to run | Max context here |
|---|---|---|---|---|---|
| `glm-4-9b-0414-iq4xs` | 5.3 GB | flagship | reason 5/5, code 5/5, chat 5/5 | 7.9 GB | 32,768 @8GB free |
| `glm-4-9b-0414-iq3m` | 4.7 GB | — | reason 4/5, code 4/5, chat 4/5 | 7.4 GB | 32,768 @8GB free |
| `qwen2.5-coder-7b-q4` | 4.7 GB | code-heavy | reason 4/5, code 5/5, chat 4/5 | 7.6 GB | 32,768 @8GB free |
| `deepseek-r1-distill-qwen-7b` | 4.7 GB | — | reason 5/5, code 4/5, chat 3/5 | 7.6 GB | 32,768 @8GB free |
| `qwen3-4b-instruct-2507` | 2.5 GB | default, critic | reason 5/5, code 4/5, chat 5/5 | 6.9 GB | 32,768 @8GB free |
| `qwen3-vl-4b-instruct` | 3.3 GB | vision | reason 4/5, code 3/5, chat 4/5, vision 5/5 | 7.7 GB | 32,768 @8GB free |
| `gemma-3-4b-it` | 2.5 GB | — | reason 4/5, code 4/5, chat 5/5 | 6.8 GB | 32,768 @8GB free |
| `phi-3-mini-4k-q4` | 2.4 GB | — | reason 3/5, code 2/5, chat 3/5 | 4.9 GB | 4,096 @8GB free |
| `phi-4-mini-instruct-q4` | 2.5 GB | — | reason 5/5, code 3/5, chat 4/5 | 6.6 GB | 32,768 @8GB free |
| `sdxl-turbo-q4` | 2.8 GB | image | image 4/5 | 4.2 GB | n/a |
| `qwen2.5-coder-1.5b-q4` | 1.1 GB | code | reason 3/5, code 4/5, chat 3/5 | 3.6 GB | 32,768 @8GB free |
| `bge-reranker-v2-m3` | 0.6 GB | reranker | rerank 5/5 | 2.0 GB | n/a |
| `bge-small-en-v1.5` | 37 MB | embedding | embed 4/5 | 1.4 GB | n/a |

_Context figures assume the q8 KV cache and flash attention the engine enables by
default. "Does not fit 8 GB" means the planner will refuse it and tell you how much
to free — it will not try and stall the machine._

### What it can do

**Reading your workspace** — `fs.read`

| Tool | Behaviour |
|---|---|
| `check_schematic` | runs automatically |
| `extract_pdf` | runs automatically |
| `list_files` | runs automatically |
| `query_data` | runs automatically |
| `read_file` | runs automatically |
| `read_image` | runs automatically |
| `read_image_text` | runs automatically |
| `read_pdf` | runs automatically |
| `search_files` | runs automatically |
| `semantic_search` | runs automatically |

**Changing files** — `fs.write`

| Tool | Behaviour |
|---|---|
| `build_model` | runs, then shows you the change (revertable) |
| `capture_drawing` | runs, then shows you the change (revertable) |
| `delete_file` | **asks first** |
| `draw_diagram` | runs, then shows you the change (revertable) |
| `draw_schematic` | runs, then shows you the change (revertable) |
| `edit_file` | runs, then shows you the change (revertable) |
| `edit_image` | runs, then shows you the change (revertable) |
| `edit_pdf` | runs, then shows you the change (revertable) |
| `export_schematic` | runs, then shows you the change (revertable) |
| `make_dir` | runs, then shows you the change (revertable) |
| `move_file` | runs, then shows you the change (revertable) |
| `redline_drawing` | runs, then shows you the change (revertable) |
| `transcribe_audio` | runs, then shows you the change (revertable) |
| `write_file` | runs, then shows you the change (revertable) |

**System & utility** — `sys.read`

| Tool | Behaviour |
|---|---|
| `calculate` | runs automatically |
| `find_api` | runs automatically |
| `find_symbol` | runs automatically |
| `inspect_devices` | runs automatically |
| `knowledge_search` | runs automatically |
| `process_list` | runs automatically |
| `read_clipboard` | runs automatically |
| `simulate_circuit` | runs automatically |
| `stop_server` | runs automatically |
| `suggest_model` | runs automatically |
| `system_stats` | runs automatically |

**System write** — `sys.write`

| Tool | Behaviour |
|---|---|
| `write_clipboard` | runs, then shows you the change (revertable) |

**Running commands** — `sys.execute`

| Tool | Behaviour |
|---|---|
| `build_app` | **asks first** |
| `run_dev_server` | **asks first** |
| `run_script` | **asks first** |
| `sandbox_test` | **asks first** |
| `scaffold_app` | **asks first** |
| `serve_folder` | **asks first** |

**Connected hardware** — `device.write`

| Tool | Behaviour |
|---|---|
| `backup_firmware` | **asks first** |
| `board_identify` | **asks first** |
| `flash_device` | **asks first** |
| `install_toolchain` | **asks first** |
| `serial_read` | **asks first** |
| `serial_write` | **asks first** |

**GitHub & version control** — `vcs.git`

| Tool | Behaviour |
|---|---|
| `git_clone` | **asks first** |
| `github_sign_in` | **asks first** |

**Media inspection** — `media.read`

| Tool | Behaviour |
|---|---|
| `media_probe` | runs automatically |

**Media conversion** — `media.write`

| Tool | Behaviour |
|---|---|
| `generate_image` | runs, then shows you the change (revertable) |
| `media_transform` | runs, then shows you the change (revertable) |

**Defensive security** — `sec.defensive`

| Tool | Behaviour |
|---|---|
| `audit_code` | runs automatically |
| `audit_dependencies` | runs automatically |
| `crypto_auth_review` | runs automatically |
| `review_config` | runs automatically |
| `scan_secret_history` | runs automatically |
| `scan_secrets` | runs automatically |

**Network** — `net.read`

| Tool | Behaviour |
|---|---|
| `ask_cloud_model` | **asks first** (and network is off by default) |
| `ask_fleet` | **asks first** (and network is off by default) |
| `ask_reasoner` | **asks first** (and network is off by default) |
| `http_fetch` | **asks first** (and network is off by default) |
| `research_topic` | **asks first** (and network is off by default) |
| `web_search` | **asks first** (and network is off by default) |

**Offensive security (authorized only)** — `sec.offensive`

| Tool | Behaviour |
|---|---|
| `exploit_validate` | **asks first**, and only against an authorized engagement |
| `fuzz_target` | **asks first**, and only against an authorized engagement |
| `port_scan` | **asks first**, and only against an authorized engagement |

Every capability is deny-by-default. A tool marked **asks first** cannot run without a
separate, explicit approval that names the exact action — the model can only ever
*propose* it. Network access is off until you turn it on, and offensive tools stay
unavailable until you create a time-boxed engagement naming one authorized host.

### Formats it reads
| Kind | Extensions |
|---|---|
| Text & code | `.txt .md .js .ts .py .json .yaml .xml .csv .html .css` and similar |
| Documents | `.pdf` (real text extraction, page-cited) |
| Scanned pages | `.png .jpg .jpeg .tif .webp .bmp` via offline OCR, upscaled when low-res |
| Images (vision) | `.png .jpg` with a vision model loaded |
| Media | audio/video probing and conversion via bundled ffmpeg |

<!-- CAPABILITY-MAP:END -->

## If you want to poke it after installing

1. **Ask it something with the network off.** Confirm it answers. That is the whole thesis.
2. **Link the built-in reference library, then ask a physics or engineering question** and watch it
   cite a real book by name and page.
3. **Link a folder** and ask what is in it, then ask it to change something and watch the diff.
4. **Plug in a dev board**, open Connections, and hit Scan for devices — then, if you like, ask it to
   read the board's boot log.
5. **Drop in a scanned PDF** and ask what it says. That is the OCR, the upscaler and the quality gate
   all working at once.
6. **Hold the dictation key** and talk to it.
7. **Try to make it do something dangerous.** Ask it to delete something, flash a board, or scan a
   host. It should stop and show you the exact action, or refuse outright. That is the part worth
   testing hardest.

## A fresh clone

The repository holds SOURCE — about 6 MB. Runtimes, third-party tool executables, model weights and
the knowledge corpus are large, immutable and re-downloadable, so they are fetched rather than
committed (two of them exceed GitHub's hard 100 MB file limit on their own).

```bash
npm install --prefix app
node devtools/fetch-binaries.js
node devtools/fetch-knowledge.js
```

`fetch-binaries.js` brings down llama.cpp, ffmpeg, whisper.cpp, qpdf, ImageMagick, SQLite, Graphviz
and the default models; `fetch-knowledge.js` brings down the shipped corpus. Pass `--list` to either
one to see every source URL and licence without downloading anything, and a group name (`runtimes`,
`tools`, `models`) to fetch just that part.

Both verify what they download rather than trusting that a file appeared: a truncated PDF keeps its
`%PDF` header and loses its `%%EOF` trailer, and a truncated archive unpacks to nothing useful. That
check exists because two volumes of the corpus were once silently half-downloaded.

The knowledge index the product actually ships is rebuilt from the corpus with
`devtools/build-knowledge-index.js` (under Electron, so the PDF rasterizer is available) followed by
`devtools/pack-knowledge-index.js`.

## Roadmap

What ships today is everything above. Where it is going — planned, not built, and named honestly as
such:

- **More local engines.** Language models run on llama.cpp and images on stable-diffusion.cpp today.
  More model families and faster runtimes are planned, each chosen for the machine it runs on.
- **More than one machine, working together.** Point a session at a workstation or GPU box you own
  and let the heavier jobs run there. The groundwork — the four-place model picker, node awareness,
  and image generation that already falls back to a node you own — is in the app.
- **macOS.** Windows today; a Mac build is planned.
- **A dedicated phone client** for the node door, beyond today's token-authenticated HTTPS endpoint.

`.lcl` is its own thing — a standalone local workbench, not a front-end for anything else. It talks
to hardware, other machines and cloud APIs only when you tell it to, and it is designed so that the
day you switch every one of those off, it still works.

## License

MIT © PragOptics. See [LICENSE](LICENSE).
