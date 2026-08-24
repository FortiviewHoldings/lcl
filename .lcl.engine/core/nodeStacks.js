/**
 * PUTTING A CAPABILITY ON THE NODE, FROM HERE.
 *
 * The model library gets WEIGHTS onto the Spark. Weights are useless without
 * something to run them, and that something is what NVIDIA's own playbooks
 * install. This is that half: the stacks, and what it takes to stand each one
 * up, so the operator can add a capability without leaving the app.
 *
 * TWO KINDS OF ENTRY, AND THE DIFFERENCE IS DELIBERATE.
 *
 *   `steps`  — commands this app will actually run on the node. Written only
 *              for the stacks whose install has been read end to end, and
 *              written to be IDEMPOTENT: run it twice and the second run
 *              changes nothing.
 *
 *   `manual` — everything else. A link to the playbook and the honest
 *              sentence that .lcl does not install it. Isaac Sim is a
 *              multi-gigabyte simulator with its own licensing flow; OpenShell
 *              is a security tool whose setup deserves reading before running.
 *              Inventing plausible-looking install commands for those and
 *              running them on the operator's hardware is exactly the
 *              confident nonsense this app exists not to produce.
 *
 * NOTHING HERE TAKES A STRING FROM THE UI. Every command is a literal in this
 * file. The only thing the caller chooses is WHICH entry, by key.
 */

/* pip prints no progress at all without a terminal, and this transport has
 * none. --progress-bar raw is its documented answer: plain `Progress N of M`
 * lines. The installs are otherwise the playbooks' own commands. */
const PIP_SEEN = "python3 -m pip install --progress-bar raw";

/* PROVISION, DO NOT REFUSE.
 *
 * The reason .lcl exists: you cannot just install a pile of things and expect
 * them to work together.
 *
 * Measured on a Spark: clang absent, nvcc present but not on PATH, pipx absent,
 * and Docker running with no NVIDIA runtime registered. Every recipe that
 * needed one of those stopped at a preflight and printed an apt line to go and
 * paste into a terminal — which is exactly the manual work this app exists to
 * avoid. llamacpp died in 418 ms on a missing clang and reported
 * "did not finish".
 *
 * A preflight that CAN fix what it found should fix it. These helpers install
 * what is missing and refuse only when they genuinely cannot: no sudo, and no
 * password typed into the box on the Run panel.
 */

// `sudo -A` throughout, never `sudo -n`. SUDO_PRIME in app/main.js points
// SUDO_ASKPASS at a helper that supplies the password the operator typed, so
// every call that needs one gets one. A node with passwordless sudo never
// invokes the helper, so the SAME form works there — which is why there is no
// second spelling of this to keep in sync.
//
// -n was the old form and it depended on sudo having CACHED the credential
// from a prime. On a Spark the prime succeeded and the next -n failed 505 ms
// later: caching is a machine policy (timestamp_timeout=0 turns it off) and
// building on it made a typed password work or not depending on somebody's
// image.
const NEED_PW = "{ echo LCL-NEEDS-PASSWORD; exit 1; }";

/* NO TEMPLATE LITERAL BUILDS A `run`. It is the one construct that can splice
 * a value from this process into a string that becomes a shell command on the
 * operator's hardware, and the suite refuses them on sight — correctly, since
 * proving a particular one is safe is work nobody should have to redo.
 *
 * The package list is a literal at every call site in this file, and this
 * checks that anyway: a Debian package name, nothing else, or it throws at
 * load rather than composing a command out of whatever it was handed. */
const PKG_OK = /^[a-z0-9][a-z0-9.+-]*$/;

function aptStep(pkgs, why) {
    for (const p of pkgs) {
        if (!PKG_OK.test(p)) throw new Error("not a package name: " + p);
    }
    const list = pkgs.join(" ");
    return {
        say: why || "installing " + pkgs.join(", ") + " if the node does not have them",
        run:
            "missing=\"\"; for p in " + list + "; do dpkg -s \"$p\" >/dev/null 2>&1 || " +
            "missing=\"$missing $p\"; done; " +
            "[ -z \"$missing\" ] && echo LCL-DEPS-PRESENT || { " +
            "echo \"installing:$missing\"; " +
            "sudo -A true 2>/dev/null || " + NEED_PW + "; " +
            "sudo -A apt-get update -qq 2>/dev/null || true; " +
            "sudo -A env DEBIAN_FRONTEND=noninteractive apt-get install -y $missing || " +
            "{ echo LCL-APT-FAILED; exit 1; }; }"
    };
}

/* The toolkit, then the runtime registration, then a restart — NVIDIA's own
 * three lines from the sglang and jax playbooks, in that order. Docker's own
 * `docker info` is what says whether it worked, which is also what every one of
 * these recipes was already checking. */
/* NVIDIA's own container and example model from the vLLM playbook. gpt-oss-20b
 * is public, so no Hugging Face token is needed to stand this up. */
const VLLM_IMAGE = "nvcr.io/nvidia/vllm:26.05.post1-py3";
const VLLM_MODEL = "openai/gpt-oss-20b";

/* THE DRIVER/FLEET LITERALS. The driver is gpt-oss-120b as a GGUF on
 * llama.cpp:30000 — vLLM could not hold it on this box, because mmap plus the
 * driver copy is double residency — and the fleet is gpt-oss-20b on vLLM:8000
 * at a FIXED quarter. Verbatim from the proven run, and the suite pins
 * every flag, because a drifted literal is a different run. */
const GPTOSS_DRIVER_EXEC =
    "'ExecStart=%h/llama.cpp/build/bin/llama-server " +
    "-hf unsloth/gpt-oss-120b-GGUF:F16 --jinja -np 4 -c 65536 " +
    "--host 0.0.0.0 --port 30000' ";
/* ONE source line from serve through its share, so the sweep in
 * tests/vllm-launch.js reads this literal like every other: no serve line
 * ships without --gpu-memory-utilization. The quarter is the DESIGN — the
 * driver owns the rest — never the measured share the generic recipe takes. */
const FLEET_20B_RUN =
    "docker run -d --gpus all -p 8000:8000 --name vllm-server " +
    "--restart unless-stopped " +
    "-v \"$HOME/.cache/huggingface:/root/.cache/huggingface\" " +
    VLLM_IMAGE + " " +
    "vllm serve openai/gpt-oss-20b --gpu-memory-utilization 0.25 --max-model-len 32768 --max-num-seqs 8";

/* THE ONE MISSING FLAG THAT COST 641 RESTARTS.
 *
 * NVIDIA's playbook line is `vllm serve <model>` and nothing more, because it
 * is written for a machine where vLLM is the only thing running. vLLM then
 * takes its default share — 0.9 of TOTAL memory — and REFUSES TO START unless
 * that much is free at that moment. On a Spark, Ollama and llama.cpp were
 * already holding 36 GB, so it asked for 111.95 GiB of the 85.92 GiB that was
 * free, threw a ValueError, and `--restart unless-stopped` faithfully did it
 * again 641 times while the wizard sat on "waiting for it to answer".
 *
 * Three engines cannot each assume they own the box, and on a Spark the GPU
 * pool IS the system pool, so the share is MEASURED on the node at launch
 * rather than assumed. $UTIL comes from the step before this one.
 *
 * `--restart unless-stopped` stays, for the reason it was added: a server that
 * dies with the ssh connection is the "it worked while I was watching"
 * failure. What was missing is that nothing ever LOOKED at the restart count,
 * so a container that could never start looked exactly like one still loading.
 * The wait step reads it now. */
function vllmRun(extra) {
    return "docker run -d --gpus all -p 8000:8000 --name vllm-server " +
           "--restart unless-stopped " + VLLM_IMAGE + " " +
           "vllm serve " + VLLM_MODEL + " --gpu-memory-utilization $UTIL" +
           (extra || "");
}

const DOCKER_GPU = {
    say: "making sure Docker can see the GPU",
    run:
        "if docker info 2>/dev/null | grep -qi nvidia; then echo LCL-HAS-NVIDIA-RUNTIME; else " +
        "echo 'the NVIDIA container runtime is not registered with Docker — installing it'; " +
        "sudo -A true 2>/dev/null || " + NEED_PW + "; " +
        "sudo -A apt-get update -qq 2>/dev/null || true; " +
        "sudo -A env DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit || " +
        "{ echo LCL-APT-FAILED; exit 1; }; " +
        "sudo -A nvidia-ctk runtime configure --runtime=docker || " +
        "{ echo LCL-CTK-FAILED; exit 1; }; " +
        "sudo -A systemctl restart docker; " +
        "LCL_OK=no; for i in $(seq 1 20); do " +
        "docker info 2>/dev/null | grep -qi nvidia && { LCL_OK=yes; break; }; " +
        "[ $((i % 5)) -eq 0 ] && echo \"waiting for Docker — $((i * 2))s\"; sleep 2; done; " +
        "[ \"$LCL_OK\" = yes ] && echo LCL-HAS-NVIDIA-RUNTIME || " +
        "{ echo LCL-NO-NVIDIA-RUNTIME; exit 1; }; fi"
};

/* earlyoom shot vllm mid-shard-load: the fresh 61 GB sat in page cache,
 * available dipped, and it killed the biggest process instead of letting the
 * kernel evict cache. The grep gates the sed, so running this twice leaves
 * ONE flag — and the suite runs it twice against a fixture to prove it. */
const EARLYOOM_GUARD = {
    say: "telling earlyoom never to shoot the model server (idempotent)",
    run: "if [ ! -f /etc/default/earlyoom ]; then echo LCL-NO-EARLYOOM; " +
         "elif grep -q -- '--avoid vllm' /etc/default/earlyoom; then echo LCL-EARLYOOM-GUARDED; " +
         "else sudo -A true 2>/dev/null || " + NEED_PW + "; " +
         "if grep -q '^EARLYOOM_ARGS=' /etc/default/earlyoom; then " +
         "sudo -A sed -i 's/^EARLYOOM_ARGS=\"\\(.*\\)\"/EARLYOOM_ARGS=\"\\1 --avoid vllm\"/' /etc/default/earlyoom; " +
         "else echo 'EARLYOOM_ARGS=\"-r 3600 --avoid vllm\"' | sudo -A tee -a /etc/default/earlyoom >/dev/null; fi; " +
         "sudo -A systemctl restart earlyoom 2>/dev/null || true; " +
         "echo LCL-EARLYOOM-GUARDED; fi"
};

/* Before a big model loads, the page cache is still holding whatever
 * downloaded last — the coexist math needs to see REAL free memory. */
const DROP_CACHES = {
    say: "dropping the page cache so the load starts with real free memory",
    run: "sudo -A true 2>/dev/null || " + NEED_PW + "; " +
         "sudo -A sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches' && echo LCL-CACHES-DROPPED"
};

/* nvcc ships on a Spark but is not on PATH, so a CUDA build configures itself
 * as a CPU build and the operator finds out an hour later. One export, early:
 * script() joins every step into ONE shell, so this holds for all of them. */
/* Two recipes need Ollama and both used to stop and print the curl line.
 * install.sh writes /usr/local/bin, so it is run under sudo — the same
 * sudo this run already unlocked. */
const ENSURE_OLLAMA = {
    say: "installing Ollama if the node does not have it",
    run: "command -v ollama >/dev/null && echo LCL-HAS-OLLAMA || { " +
        "echo 'Ollama is not on this node — installing it'; " +
        "sudo -A true 2>/dev/null || " + NEED_PW + "; " +
        "curl -fsSL https://ollama.com/install.sh | sudo -A sh || " +
        "{ echo LCL-OLLAMA-INSTALL-FAILED; exit 1; }; }"
};

const CUDA_PATH = {
    say: "putting the CUDA toolchain on the path",
    run: 'for d in /usr/local/cuda/bin /usr/local/cuda-13/bin /usr/local/cuda-13.0/bin; do ' +
         '[ -x "$d/nvcc" ] && { export PATH="$d:$PATH"; break; }; done; ' +
         'command -v nvcc >/dev/null && echo "nvcc: $(command -v nvcc)" || ' +
         'echo "no nvcc found — a CUDA build will fall back to CPU"'
};

/* The clone/configure/build of llama.cpp, shared verbatim by the generic
 * llamacpp recipe and the gpt-oss-120b driver: one build, two ExecStarts. */
const LLAMACPP_BUILD = [
    { say: "fetching llama.cpp",
      run: "test -d \"$HOME/llama.cpp/.git\" || git clone " +
           "https://github.com/ggml-org/llama.cpp \"$HOME/llama.cpp\"" },
    { say: "configuring for the Spark's GPU (sm_121)",
      run: "cd \"$HOME/llama.cpp\" && cmake -B build -DGGML_NATIVE=ON " +
           "-DGGML_CUDA=ON -DGGML_CURL=ON " +
           // NOT SILENCED: a multi-minute CUDA configure whose output is the
           // only sign it is alive. Muting it is what let the idle
           // timer kill a real run at five minutes.
           "-DCMAKE_CUDA_ARCHITECTURES=121a-real" },
    { say: "building llama-server (the long part)",
      run: "cd \"$HOME/llama.cpp\" && cmake --build build --config Release " +
           "--target llama-server -j" },
];

const STACKS = [
    {
        key: "comfyui",
        name: "ComfyUI — images and video",
        why: "The one that unlocks the most: Stable Diffusion, FLUX, Wan 2.1, " +
             "HunyuanVideo and Cosmos in one install. .lcl speaks its API " +
             "directly, so once this is up, image generation that will not fit " +
             "on this laptop runs on the node instead — and never on a paid " +
             "endpoint unless you ask.",
        playbook: "https://build.nvidia.com/spark/comfyui",
        takes: null,
        serves: "port 8188",
        // no endpoint: images, not an OpenAI model API — .lcl speaks ComfyUI's own protocol
        noEndpoint: "images, not an OpenAI model API — .lcl speaks ComfyUI's own protocol",
        needs: "~20 GB disk for the quick start; ~70 GB for the video tiers",
        // The Image Gen Quick Start path: a host Python install, which is the
        // lighter of the two the playbook offers and the one that gets .lcl's
        // image tier working. The container path for video is deliberately not
        // automated here — it wants a Hugging Face token and tiered model
        // downloads that belong in front of the operator, not behind a button.
        steps: [
            { say: "checking for python and git",
              run: "command -v python3 >/dev/null && command -v git >/dev/null" },
            { say: "fetching ComfyUI",
              run: "test -d \"$HOME/ComfyUI/.git\" || git clone --depth 1 " +
                   "https://github.com/comfyanonymous/ComfyUI.git \"$HOME/ComfyUI\"" },
            { say: "making a virtual environment",
              run: "test -d \"$HOME/ComfyUI/venv\" || python3 -m venv \"$HOME/ComfyUI/venv\"" },
            { say: "installing its requirements (this is the long part)",
              run: "\"$HOME/ComfyUI/venv/bin/pip\" install --upgrade pip >/dev/null && " +
                   "\"$HOME/ComfyUI/venv/bin/pip\" install -r \"$HOME/ComfyUI/requirements.txt\"" },
            { say: "making the model folders",
              run: "mkdir -p \"$HOME/ComfyUI/models/checkpoints\" " +
                   "\"$HOME/ComfyUI/models/diffusion_models\" " +
                   "\"$HOME/ComfyUI/models/loras\"" },
            // A SERVICE, NOT A TERMINAL SESSION. Started by hand over ssh it
            // dies with the connection, which is the classic "it worked while
            // I was watching" failure. systemd --user keeps it up and brings
            // it back after a reboot.
            { say: "installing it as a service so it survives a reboot",
              run: "mkdir -p \"$HOME/.config/systemd/user\" && " +
                   "printf '%s\\n' " +
                   "'[Unit]' 'Description=ComfyUI' 'After=network.target' " +
                   "'[Service]' 'WorkingDirectory=%h/ComfyUI' " +
                   "'ExecStart=%h/ComfyUI/venv/bin/python main.py --listen 0.0.0.0 --port 8188' " +
                   "'Restart=on-failure' " +
                   "'[Install]' 'WantedBy=default.target' " +
                   "> \"$HOME/.config/systemd/user/comfyui.service\" && " +
                   "systemctl --user daemon-reload && systemctl --user enable --now comfyui" },
            { say: "checking it answers",
              run: "for i in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:8188/system_stats " +
                   ">/dev/null && echo LCL-COMFY-UP && exit 0; [ $((i % 15)) -eq 0 ] && echo \"still working — $((i * 2))s\"; sleep 2; done; " +
                   "echo LCL-COMFY-NOT-UP; exit 1" }
        ],
        verify: "LCL-COMFY-UP",
        rollback: "systemctl --user disable --now comfyui, then delete ~/ComfyUI"
    },

    {
        key: "vllm",
        name: "vLLM — faster LLM serving",
        why: "A straight upgrade over Ollama for serving: continuous batching, " +
             "PagedAttention, and an OpenAI-compatible API — which .lcl already " +
             "speaks, so nothing in the app has to change. Point a node at it " +
             "and it just answers faster.",
        playbook: "https://build.nvidia.com/spark/vllm",
        takes: "30 minutes for Docker approach",
        serves: "port 8000",
        endpoint: { port: 8000, path: "/v1", shape: "openai" },
        needs: "Docker and the NVIDIA Container Toolkit; a Hugging Face token for gated models",
        /* IT SERVES A MODEL NOW, INSTEAD OF HANDING OVER A LINK.
         *
         * The automation has to actually work — the node should function, not
         * just be made ready.
         *
         * This checked the box was ready and stopped, because vLLM fixes its
         * context window at launch and the model is a real decision. Both true,
         * and still the wrong call: Ollama and llama.cpp ship a chosen default
         * you change afterwards, and "you must choose" is not a reason to
         * automate nothing.
         *
         * Container, model and health check are NVIDIA's own from the playbook.
         * gpt-oss-20b is public, so no Hugging Face token is needed to stand it
         * up. `--restart unless-stopped` is this app's addition, for the reason
         * every recipe installs a service: a server that dies with the ssh
         * connection is the "it worked while I was watching" failure. */
        steps: [
            DOCKER_GPU,
            { say: "fetching the vLLM container — several GB, and Docker reports no percentage without a terminal, so watch the layer lines",
              run: "docker image inspect " + VLLM_IMAGE + " >/dev/null 2>&1 && " +
                   "echo LCL-VLLM-IMAGE-PRESENT || docker pull " + VLLM_IMAGE },
            { say: "measuring what is actually free, then starting vLLM on port 8000",
              run: "if curl -sf -m 3 http://127.0.0.1:8000/health >/dev/null 2>&1; then " +
                   "echo LCL-VLLM-ALREADY-UP; else " +
                   "docker rm -f vllm-server >/dev/null 2>&1 || true; " +
                   "FREE=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits " +
                   "2>/dev/null | head -1 | tr -dc 0-9 || true); " +
                   "TOT=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits " +
                   "2>/dev/null | head -1 | tr -dc 0-9 || true); " +
                   "SFREE=$(free -m 2>/dev/null | " +
                   "awk '/^Mem:/ {print ($7 != \"\" ? $7 : $4)}' | tr -dc 0-9 || true); " +
                   "STOT=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}' | tr -dc 0-9 || true); " +
                   "if [ -z \"$FREE\" ] || [ -z \"$TOT\" ]; then " +
                   "echo 'nvidia-smi gave no figure, so this is the system pool — on a Spark that is the same memory'; " +
                   "FREE=\"$SFREE\"; TOT=\"$STOT\"; fi; " +
                   "if [ -n \"$SFREE\" ] && [ -n \"$FREE\" ] && [ \"$SFREE\" -lt \"$FREE\" ]; then " +
                   "FREE=\"$SFREE\"; fi; " +
                   "if [ -z \"$FREE\" ] || [ -z \"$TOT\" ] || [ \"$TOT\" -le 0 ]; then " +
                   "echo LCL-VLLM-NO-MEASURE; exit 1; fi; " +
                   // 16 GiB, not 8. Measured consequence of 8: vLLM sized itself, the
                   // operator CHATTED with llama.cpp beside it, the KV cache grew into
                   // the last 8 GiB and the machine thrashed until the power button.
                   // Headroom is for the live growth of the OTHER engines, not just OS.
                   "PCT=$(( (FREE - 16384) * 100 / TOT )); " +
                   "if [ \"$PCT\" -gt 90 ]; then PCT=90; fi; " +
                   "if [ \"$PCT\" -lt 20 ]; then " +
                   "echo \"only $FREE MiB of $TOT MiB is free — unload a model in Ollama or stop " +
                   "llama.cpp, then run this again\"; echo LCL-VLLM-NO-ROOM; exit 1; fi; " +
                   "UTIL=0.$PCT; echo $UTIL > /tmp/lcl-vllm-util; " +
                   "echo \"$FREE MiB free of $TOT MiB, so vLLM is told to take $UTIL of the box. " +
                   "Its own default is 0.9 of the TOTAL, which is what fails on a machine that is " +
                   "already serving\"; " +
                   vllmRun("") + "; fi" },
            { say: "waiting for it to answer (the first start loads the model)",
              run: "UTIL=$(cat /tmp/lcl-vllm-util 2>/dev/null || echo 0.60); " +
                   "LCL_UP=no; TRIED=no; i=0; " +
                   "while [ $i -lt 90 ]; do i=$((i + 1)); " +
                   "curl -sf -m 3 http://127.0.0.1:8000/health >/dev/null 2>&1 && " +
                   "{ LCL_UP=yes; break; }; " +
                   "RC=$(docker inspect -f '{{.RestartCount}}' vllm-server 2>/dev/null | " +
                   "tr -dc 0-9 || true); " +
                   "if [ -n \"$RC\" ] && [ \"$RC\" -ge 2 ]; then " +
                   "echo \"vLLM has restarted $RC times without ever answering, so it is not " +
                   "starting. What it said:\"; " +
                   "docker logs --tail 60 vllm-server 2>&1 | " +
                   "grep -iE 'error|out of memory|no space' | tail -8 || true; " +
                   "KV=$(docker logs --tail 80 vllm-server 2>&1 | " +
                   "grep -o 'KV cache ([0-9]*)' | tail -1 | tr -dc 0-9 || true); " +
                   "if [ \"$TRIED\" = no ] && [ -n \"$KV\" ]; then TRIED=yes; " +
                   "echo \"that is the context window, not the model: $KV tokens is all the KV " +
                   "cache holds at this memory share, so it restarts with --max-model-len $KV, " +
                   "the largest window that fits\"; " +
                   "docker rm -f vllm-server >/dev/null 2>&1 || true; " +
                   vllmRun(" --max-model-len $KV") + "; i=0; sleep 10; continue; fi; " +
                   "docker rm -f vllm-server >/dev/null 2>&1 || true; " +
                   "echo LCL-VLLM-CRASHLOOP; exit 1; fi; " +
                   "if [ $((i % 3)) -eq 0 ]; then echo \"still working — $((i * 10))s\"; fi; " +
                   "sleep 10; done; " +
                   "if [ \"$LCL_UP\" = yes ]; then echo LCL-VLLM-UP; else " +
                   "echo LCL-VLLM-NOT-UP; docker logs --tail 20 vllm-server 2>&1 || true; " +
                   "exit 1; fi" },
        ],
        verify: "LCL-VLLM-UP",
        // AND THE ONE FLAG THAT COST AN AFTERNOON IS NAMED HERE.
        //
        // Ollama serves with its own num_ctx — 4,096 unless told otherwise —
        // whatever the model supports, so a 70B on a Spark answered a
        // repository-sized prompt having read four thousand tokens of it. vLLM
        // takes the window at LAUNCH, not per request, which means getting it
        // wrong here cannot be corrected by anything .lcl sends afterwards.
        after: "vLLM is serving openai/gpt-oss-20b on port 8000 and is linked as " +
               "an endpoint. Its memory share was measured, not assumed: it took " +
               "what was free with Ollama and llama.cpp still holding theirs, so " +
               "all three run at once. Unload a lot in Ollama and vLLM keeps the " +
               "share it started with — the share is fixed AT LAUNCH, like the " +
               "window. To serve a different model, or a bigger window: docker rm " +
               "-f vllm-server, then the same command with your model, " +
               "--gpu-memory-utilization and --max-model-len. vLLM fixes the " +
               "context AT LAUNCH, so a low value cannot be raised by anything " +
               ".lcl sends afterwards.",
        rollback: "docker rm -f vllm-server, then docker rmi " +
                  "nvcr.io/nvidia/vllm:26.05.post1-py3"
    },

    {
        key: "nvfp4",
        name: "NVFP4 quantization toolkit",
        why: "Blackwell's native 4-bit. This is the lever that decides WHICH " +
             "models fit at all — the difference between a 70B with headroom " +
             "and a 70B that swaps. Worth having before choosing a model line-up.",
        playbook: "https://build.nvidia.com/spark/nvfp4-quantization",
        takes: "about 2 hours",
        needs: "Python and pip; the quantizing itself is heavy and per-model",
        steps: [
            { say: "installing NVIDIA Model Optimizer",
              run: PIP_SEEN + " --user --upgrade \"nvidia-modelopt[all]\" " +
                   "&& echo LCL-MODELOPT-OK" }
        ],
        verify: "LCL-MODELOPT-OK",
        after: "Quantizing a model is a per-model job with its own settings — " +
               "the playbook walks through it.",
        rollback: "python3 -m pip uninstall nvidia-modelopt"
    },


    {
        key: "coder",
        name: "Local coding model — Ollama + Qwen3.6",
        why: "The shortest path in the whole catalogue to a WORKING coding " +
             "model on the node: one pull, and an OpenAI-compatible endpoint " +
             "on 11434 that .lcl can drive the same day with no app changes. " +
             "Coding models are among the first things asked of a node, and " +
             "the survey's biggest blind spot was that this playbook " +
             "family existed at all.",
        playbook: "https://build.nvidia.com/spark/cli-coding-agent",
        takes: "~15-25 minutes (mostly model download time)",
        serves: "port 11434",
        // no endpoint: it is Ollama's port, and the ollama recipe already links it
        noEndpoint: "it is Ollama's port, and the ollama recipe already links it",
        needs: "Ollama v0.15+ on the node; ~22 GB download for the default precision",
        // Ollama's own installer wants sudo, which nothing in this module
        // runs. So this CHECKS and tells — the same temperament as the vLLM
        // prerequisite entry — then does everything after that for real.
        steps: [
            ENSURE_OLLAMA,
            { say: "checking Ollama is installed",
              run: "command -v ollama >/dev/null && echo LCL-HAS-OLLAMA || " +
                   "{ echo LCL-NO-OLLAMA; exit 1; }" },
            { say: "pulling Qwen3.6 (the long part — ~22 GB, idempotent)",
              run: "ollama list 2>/dev/null | grep -q qwen3.6 || ollama pull qwen3.6" },
            { say: "checking the endpoint answers with the model",
              run: "for i in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:11434/v1/models " +
                   "2>/dev/null | grep -q qwen3.6 && echo LCL-CODER-UP && exit 0; [ $((i % 15)) -eq 0 ] && echo \"still working — $((i * 2))s\"; sleep 2; done; " +
                   "echo LCL-CODER-NOT-UP; exit 1" }
        ],
        verify: "LCL-CODER-UP",
        after: "Add the node's 11434 here as an endpoint and the coding model " +
               "is a driver like any other. To reach it from other machines, " +
               "the playbook's OLLAMA_HOST=0.0.0.0 drop-in applies. The " +
               "playbook's `ollama launch claude|opencode|codex` agents run in " +
               "YOUR terminal by design — .lcl stops at the model and the " +
               "endpoint.",
        rollback: "ollama rm qwen3.6"
    },

    {
        key: "llamacpp",
        name: "llama.cpp server — the same engine .lcl runs locally",
        why: "The same engine .lcl already runs locally, built for the Spark's " +
             "GPU — one set of quirks instead of two, no Docker, no tokens, no " +
             "registry login. Its --spec-type draft-mtp flags also deliver " +
             "speculative decoding as two CLI options, which is the cheap " +
             "version of a whole separate playbook.",
        playbook: "https://build.nvidia.com/spark/llama-cpp",
        takes: "About 30 minutes, plus a ~35 GB model download",
        serves: "port 30000",
        // IT SERVED THE WHOLE TIME AND NOTHING COLLECTED IT. This ran to
        // completion on a Spark — built, enabled, listening on 30000 with a
        // 35B model loaded — and never reached the model picker, because the
        // prose said "port 30000" and the installer reads this field.
        endpoint: { port: 30000, path: "/v1", shape: "openai" },
        needs: "git, clang, cmake and curl/ssl headers on the node; the first " +
               "model launch downloads ~20 GB",
        steps: [
            aptStep(["git", "clang", "cmake", "libcurl4-openssl-dev", "libssl-dev"],
                    "installing the build tools if the node does not have them"),
            CUDA_PATH,
            // ...and the original check stays, because installed is not proven
            { say: "checking the build tools are installed",
              run: "command -v cmake >/dev/null && command -v git >/dev/null && " +
                   "command -v clang >/dev/null && echo LCL-HAS-BUILD-DEPS || " +
                   "{ echo LCL-NO-BUILD-DEPS; echo 'the build tools could not be installed'; " +
                   "libcurl4-openssl-dev libssl-dev; exit 1; }" },
            ...LLAMACPP_BUILD,
            /* THE WINDOW WAS WHATEVER LLAMA.CPP FELT LIKE, AND IT WAS VISIBLE.
             *
             * The reported symptom: the context window indicator still read 32k
             * for a model, and the goal was the largest possible window on a
             * local node — the most optimal the Spark can do.
             *
             * FIRST ANSWER WAS WRONG, AND THE MACHINE SAID SO.
             *
             * The 32k shown was never llama.cpp — it was .lcl's own
             * LOCAL_ASSUMED_CONTEXT, a flat guess shown as fact because nothing
             * asked the server. Measured over ssh on a Spark, with an ExecStart
             * carrying NO --ctx-size whatsoever:
             *
             *     "n_ctx": 262144
             *
             * With no flag, llama.cpp takes the model's full TRAINED context. So a
             * ladder that picks a number can only ever take window away — and at
             * the moment it was written the test box had 17 GB free, which would
             * have chosen 32768 and cut it from 256k to 32k while calling it a fix.
             *
             * So this is a SAFETY FLOOR and never a ceiling: with room, no flag at
             * all and the model keeps its own window. Only when memory is too tight
             * for the server to start does it cap, and then it says plainly that it
             * capped and why. A guard that silently downgrades the thing it was
             * asked to protect is worse than no guard. */
            { say: "measuring what is free, to size the context window",
              run: "SFREE=$(free -m 2>/dev/null | " +
                   "awk '/^Mem:/ {print ($7 != \"\" ? $7 : $4)}' | tr -dc 0-9 || true); " +
                   "NFREE=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits " +
                   "2>/dev/null | head -1 | tr -dc 0-9 || true); " +
                   "FREE=\"$SFREE\"; " +
                   "if [ -n \"$NFREE\" ] && [ -n \"$FREE\" ] && [ \"$NFREE\" -lt \"$FREE\" ]; " +
                   "then FREE=\"$NFREE\"; fi; " +
                   "if [ -z \"$FREE\" ]; then FREE=0; fi; " +
                   "if [ \"$FREE\" -ge 24576 ]; then LCL_CTXFLAG=\"\"; " +
                   "echo \"$FREE MiB free — leaving the window to the model itself, " +
                   "which is its full trained context. Measured on a Spark: 262,144 " +
                   "tokens, with no flag at all.\"; " +
                   "else LCL_CTXFLAG=\"--ctx-size 32768\"; " +
                   "echo \"only $FREE MiB free — CAPPING the window at 32,768 tokens so " +
                   "the server can start at all. This is a safety cap, not a preference: " +
                   "free memory on this machine and re-run to get the full window.\"; fi; " +
                   "export LCL_CTXFLAG" },
            { say: "installing it as a service so it survives a reboot",
              run: "mkdir -p \"$HOME/.config/systemd/user\" && " +
                   "printf '%s\\n' " +
                   "'[Unit]' 'Description=llama.cpp server' 'After=network.target' " +
                   "'[Service]' 'WorkingDirectory=%h/llama.cpp' " +
                   "'ExecStart=%h/llama.cpp/build/bin/llama-server " +
                   "-hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL " +
                   "--host 0.0.0.0 --port 30000 '\"$LCL_CTXFLAG\" " +
                   "'Restart=on-failure' " +
                   "'[Install]' 'WantedBy=default.target' " +
                   "> \"$HOME/.config/systemd/user/llamacpp.service\" && " +
                   "systemctl --user daemon-reload && systemctl --user enable llamacpp && systemctl --user restart llamacpp" },
            // NVIDIA's own health check budgets FIFTEEN MINUTES, because the
            // first launch downloads the model before it can answer. Patience
            // here is the playbook's, not this file's invention.
            { say: "waiting for it to answer (first run downloads ~20 GB)",
              run: "for i in $(seq 1 180); do curl -sf -m 2 http://127.0.0.1:30000/health " +
                   ">/dev/null && echo LCL-LLAMACPP-UP && exit 0; [ $((i % 6)) -eq 0 ] && echo \"still working — $((i * 5))s\"; sleep 5; done; " +
                   "echo LCL-LLAMACPP-NOT-UP; exit 1" }
        ],
        verify: "LCL-LLAMACPP-UP",
        after: "OpenAI-compatible on 30000 — add it as an endpoint. The context " +
               "window is the MODEL'S OWN trained context — 262,144 tokens for " +
               "this build, measured on a Spark — because no --ctx-size is passed " +
               "unless memory is too tight to start, and the install says so when " +
               "it caps. The window is fixed AT LAUNCH: to set one yourself, add " +
               "--ctx-size to ExecStart in ~/.config/systemd/user/llamacpp.service " +
               "and systemctl --user restart llamacpp. For " +
               "speculative decoding, add --spec-type draft-mtp " +
               "--spec-draft-n-max 3 to the ExecStart line.",
        rollback: "systemctl --user disable --now llamacpp, then delete ~/llama.cpp"
    },

    /* =====================================================================
     * THE TWO-ENGINE TOPOLOGY, TRANSCRIBED FROM THE PROVEN RUN.
     *
     * In the proven run: the 120B tool-caller served as a GGUF on llama.cpp —
     * the only engine it fits on here, since vLLM pays mmap plus a driver copy
     * and that double residency is more than the box — while the 20B fleet ran
     * on vLLM at a FIXED quarter beside it. ~106 of 121 GB used, 14 GB still
     * free, four parallel fleet tasks in 3.2 s. These two recipes are that
     * record, literal by literal; tests/node-stacks.js pins every flag.
     * =================================================================== */
    {
        key: "driver-llamacpp-gptoss120b",
        name: "Spark driver — gpt-oss-120b on llama.cpp",
        why: "The proven driver seat from the two-engine topology: the 120B " +
             "tool-caller as a GGUF on llama.cpp, where it actually fits — " +
             "vLLM could not hold it on this box. --jinja serves the model's " +
             "own tool template; -np 4 gives four parallel slots on one window.",
        playbook: "https://build.nvidia.com/spark/llama-cpp",
        takes: null,
        serves: "port 30000",
        endpoint: { port: 30000, path: "/v1", shape: "openai" },
        needs: "~70 GB free disk for the F16 GGUF; ~72 GB of unified memory " +
               "free while the fleet keeps its fixed quarter",
        steps: [
            aptStep(["git", "clang", "cmake", "libcurl4-openssl-dev", "libssl-dev"],
                    "installing the build tools if the node does not have them"),
            CUDA_PATH,
            ...LLAMACPP_BUILD,
            { say: "checking there is room for a 65 GB model file",
              run: "free=$(df -Pk \"$HOME\" | awk 'NR==2{print int($4/1048576)}'); " +
                   "echo \"free: ${free} GB\"; [ \"$free\" -ge 70 ] || " +
                   "{ echo LCL-NOT-ENOUGH-DISK; exit 1; }" },
            DROP_CACHES,
            { say: "the coexist math — the driver takes ~70 GB and the fleet's fixed quarter must still fit",
              run: "TOT=$(free -m | awk '/^Mem:/ {print $2}' | tr -dc 0-9); " +
                   "AVAIL=$(free -m | awk '/^Mem:/ {print $7}' | tr -dc 0-9); " +
                   "NEED=71680; " +
                   "echo \"$AVAIL MiB available of $TOT MiB — the driver needs ~$NEED MiB; the fleet keeps $((TOT / 4)) MiB for itself\"; " +
                   "[ \"$AVAIL\" -ge \"$NEED\" ] || { " +
                   "echo 'not enough beside what is already serving — stop the fleet or unload a model, then run this again'; " +
                   "echo LCL-NO-ROOM-FOR-DRIVER; exit 1; }" },
            // --avoid vllm shields the FLEET: vllm is the process earlyoom was
            // proven to shoot. The driver was never the proven victim, so the
            // guard stays verbatim to the proven run rather than growing an
            // --avoid nothing ever needed.
            EARLYOOM_GUARD,
            { say: "installing the driver unit — the same llamacpp.service and port 30000, so the existing endpoint heals into the new model",
              run: "mkdir -p \"$HOME/.config/systemd/user\" && " +
                   "printf '%s\\n' " +
                   "'[Unit]' 'Description=llama.cpp server — gpt-oss-120b driver' 'After=network.target' " +
                   "'[Service]' 'WorkingDirectory=%h/llama.cpp' " +
                   GPTOSS_DRIVER_EXEC +
                   "'Restart=on-failure' " +
                   "'[Install]' 'WantedBy=default.target' " +
                   "> \"$HOME/.config/systemd/user/llamacpp.service\" && " +
                   "systemctl --user daemon-reload && systemctl --user enable llamacpp && " +
                   "systemctl --user restart llamacpp" },
            // NVIDIA's own health check budgets fifteen minutes for a model
            // download; a 65 GB GGUF earns the hour. The MODEL is what gets
            // asked for, not the socket — port 30000 answering says nothing
            // about which ExecStart is behind it.
            { say: "waiting for it to answer WITH gpt-oss-120b (first run downloads ~65 GB)",
              run: "for i in $(seq 1 360); do " +
                   "curl -sf -m 3 http://127.0.0.1:30000/v1/models 2>/dev/null | " +
                   "grep -q gpt-oss-120b && echo LCL-DRIVER-120B-UP && exit 0; " +
                   "[ $((i % 3)) -eq 0 ] && echo \"still working — $((i * 10))s\"; sleep 10; done; " +
                   "echo LCL-DRIVER-120B-NOT-UP; " +
                   "systemctl --user status llamacpp --no-pager 2>&1 | tail -5 || true; exit 1" }
        ],
        verify: "LCL-DRIVER-120B-UP",
        after: "gpt-oss-120b is the driver on 30000 — the port the llama.cpp " +
               "endpoint already knows, so the picker heals into it. 65,536 " +
               "tokens across 4 slots, fixed at launch in the unit's ExecStart.",
        rollback: "systemctl --user disable --now llamacpp, or put the Qwen3.6 " +
                  "ExecStart back in ~/.config/systemd/user/llamacpp.service " +
                  "and restart it"
    },

    {
        key: "fleet-vllm-gptoss20b",
        name: "Spark fleet — gpt-oss-20b on vLLM",
        why: "The other half of the two-engine topology: a 20B agent fleet on " +
             "vLLM's continuous batching at a FIXED quarter of the box, beside " +
             "the 120B driver rather than instead of it. Proven: four parallel " +
             "tasks in 3.2 s with 14 GB still free.",
        playbook: "https://build.nvidia.com/spark/vllm",
        takes: null,
        serves: "port 8000",
        endpoint: { port: 8000, path: "/v1", shape: "openai" },
        needs: "Docker with the NVIDIA runtime; ~14 GB of public weights (no " +
               "token); a quarter of unified memory for as long as it runs",
        steps: [
            DOCKER_GPU,
            { say: "fetching the vLLM container if it is not already here",
              run: "docker image inspect " + VLLM_IMAGE + " >/dev/null 2>&1 && " +
                   "echo LCL-VLLM-IMAGE-PRESENT || docker pull " + VLLM_IMAGE },
            EARLYOOM_GUARD,
            // ALREADY UP is the model AND the share. The generic vLLM recipe
            // serves the same model on the same port at a MEASURED share, and
            // reporting that as this topology would fake the quarter — so the
            // container's own args are asked before the short-circuit.
            { say: "starting the fleet — a FIXED quarter of the box, so the driver keeps the rest",
              run: "if curl -sf -m 3 http://127.0.0.1:8000/v1/models 2>/dev/null | " +
                   "grep -q gpt-oss-20b && " +
                   "docker inspect -f '{{.Args}}' vllm-server 2>/dev/null | " +
                   "grep -q -- '--gpu-memory-utilization 0.25'; then " +
                   "echo LCL-FLEET-ALREADY-UP; else " +
                   "TOT=$(free -m | awk '/^Mem:/ {print $2}' | tr -dc 0-9); " +
                   "AVAIL=$(free -m | awk '/^Mem:/ {print $7}' | tr -dc 0-9); " +
                   "NEED=$((TOT / 4 + 6144)); " +
                   "echo \"$AVAIL MiB available of $TOT MiB — the quarter plus loading headroom is $NEED MiB\"; " +
                   "[ \"$AVAIL\" -ge \"$NEED\" ] || { " +
                   "echo 'no room beside what is serving — unload something, then run this again'; " +
                   "echo LCL-NO-ROOM-FOR-FLEET; exit 1; }; " +
                   "docker rm -f vllm-server >/dev/null 2>&1 || true; " +
                   FLEET_20B_RUN + "; fi" },
            { say: "waiting for it to answer WITH gpt-oss-20b (the first start pulls the weights)",
              run: "LCL_UP=no; i=0; while [ $i -lt 90 ]; do i=$((i + 1)); " +
                   "curl -sf -m 3 http://127.0.0.1:8000/v1/models 2>/dev/null | " +
                   "grep -q gpt-oss-20b && { LCL_UP=yes; break; }; " +
                   "RC=$(docker inspect -f '{{.RestartCount}}' vllm-server 2>/dev/null | tr -dc 0-9 || true); " +
                   "if [ -n \"$RC\" ] && [ \"$RC\" -ge 2 ]; then " +
                   "echo \"the fleet has restarted $RC times without answering. What it said:\"; " +
                   "docker logs --tail 40 vllm-server 2>&1 | grep -iE 'error|out of memory|no space' | tail -6 || true; " +
                   "echo LCL-FLEET-CRASHLOOP; exit 1; fi; " +
                   "[ $((i % 3)) -eq 0 ] && echo \"still working — $((i * 10))s\"; sleep 10; done; " +
                   "if [ \"$LCL_UP\" = yes ]; then echo LCL-FLEET-20B-UP; else " +
                   "echo LCL-FLEET-20B-NOT-UP; docker logs --tail 20 vllm-server 2>&1 || true; exit 1; fi" }
        ],
        verify: "LCL-FLEET-20B-UP",
        after: "The fleet serves openai/gpt-oss-20b on 8000: a 32,768-token " +
               "window, 8 concurrent sequences, all fixed at launch. Its 0.25 " +
               "share is the DESIGN, not a guess — the driver owns the rest — " +
               "so do not resize it to the measured share the generic vLLM " +
               "recipe uses. And note that the generic recipe reuses the " +
               "vllm-server container name: installing it later replaces this " +
               "fleet.",
        rollback: "docker rm -f vllm-server (the image and the mounted HF " +
                  "cache stay, so a relaunch is minutes, not a download)"
    },

    {
        key: "cutile",
        name: "cuTile — GPU kernels in Python",
        why: "The genuine answer to signal and numerical maths on the " +
             "node: FFTs, filter banks, convolution over data streams, " +
             "custom numerics — authored in Python, compiled to the Spark's " +
             "GPU. No Docker, no tokens, no daemon, no port. The catalogue's " +
             "robotics simulator was never the fit for this use; this is.",
        playbook: "https://build.nvidia.com/spark/cutile-kernels",
        takes: "30-45 minutes (including model download for LLM inference)",
        needs: "Python and pip; ~4 GB for the cu130 torch wheel",
        steps: [
            { say: "installing torch for CUDA 13 (the long part)",
              run: PIP_SEEN + " --user --pre \"torch==2.9.1\" " +
                   "--index-url https://download.pytorch.org/whl/cu130" },
            { say: "fetching TileGym",
              run: "test -d \"$HOME/TileGym/.git\" || git clone " +
                   "https://github.com/NVIDIA/TileGym \"$HOME/TileGym\"" },
            { say: "installing cuTile at its pinned release",
              run: "cd \"$HOME/TileGym\" && git checkout v1.3.0 2>/dev/null && " +
                   PIP_SEEN + " --user ." },
            { say: "proving it imports",
              run: "python3 -c \"import cutile; print('LCL-CUTILE-OK')\"" }
        ],
        verify: "LCL-CUTILE-OK",
        after: "Kernels JIT-compile per target — ct.autotune picks tile sizes " +
               "for the Spark automatically. The playbook's examples are the " +
               "starting points.",
        rollback: "python3 -m pip uninstall cutile torch, then delete ~/TileGym"
    },

    {
        key: "vlm",
        name: "Live VLM — camera to text",
        why: "Point a camera at a label, a sign, a document, a screen, " +
             "and get text back. The playbook ships an OCR preset prompt, and " +
             "it is the closest thing in the catalogue to document AI on the " +
             "node — a modality .lcl's model library does not carry at all yet.",
        playbook: "https://build.nvidia.com/spark/live-vlm-webui",
        takes: "20-30 minutes (including Ollama installation and model download)",
        serves: "port 8090 (https)",
        // no endpoint: a web UI for a camera, not a model API
        noEndpoint: "a web UI for a camera, not a model API",
        needs: "pipx and Ollama on the node; ~6 GB for the vision model",
        steps: [
            aptStep(["pipx"], "installing pipx if the node does not have it"),
            { say: "checking pipx is installed",
              run: "command -v pipx >/dev/null && echo LCL-HAS-PIPX || " +
                   "{ echo LCL-NO-PIPX; exit 1; }" },
            ENSURE_OLLAMA,
            { say: "checking Ollama is installed",
              run: "command -v ollama >/dev/null && echo LCL-HAS-OLLAMA || " +
                   "{ echo LCL-NO-OLLAMA; exit 1; }" },
            { say: "pulling the vision model (idempotent)",
              run: "ollama list 2>/dev/null | grep -q \"qwen2.5-vl\" || ollama pull qwen2.5-vl:7b" },
            { say: "installing the web UI",
              run: "pipx list 2>/dev/null | grep -q live-vlm-webui || pipx install live-vlm-webui" },
            { say: "installing it as a service so it survives a reboot",
              run: "mkdir -p \"$HOME/.config/systemd/user\" && " +
                   "printf '%s\\n' " +
                   "'[Unit]' 'Description=Live VLM WebUI' 'After=network.target' " +
                   "'[Service]' 'ExecStart=%h/.local/bin/live-vlm-webui' " +
                   "'Restart=on-failure' " +
                   "'[Install]' 'WantedBy=default.target' " +
                   "> \"$HOME/.config/systemd/user/live-vlm.service\" && " +
                   "systemctl --user daemon-reload && systemctl --user enable --now live-vlm" },
            { say: "checking it answers (self-signed https, hence -k)",
              run: "for i in $(seq 1 30); do curl -sfk -m 2 https://127.0.0.1:8090/ " +
                   ">/dev/null && echo LCL-VLM-UP && exit 0; [ $((i % 15)) -eq 0 ] && echo \"still working — $((i * 2))s\"; sleep 2; done; " +
                   "echo LCL-VLM-NOT-UP; exit 1" }
        ],
        verify: "LCL-VLM-UP",
        after: "The OCR preset lives in the UI's prompt picker. The backend is " +
               "Ollama on 11434, shared with the coding-model stack.",
        rollback: "systemctl --user disable --now live-vlm, pipx uninstall " +
                  "live-vlm-webui, ollama rm qwen2.5-vl:7b"
    },

    /* =====================================================================
     * SUDO OVER THIS TRANSPORT IS NOT INTERACTIVE.
     *
     * sshStream runs with BatchMode=yes and no -t, so there is no terminal to
     * type a password into: a bare `sudo apt install` hangs until the idle
     * timer kills it, having printed nothing useful. Every recipe below that
     * needs root therefore tests `sudo -A true` FIRST and, when passwordless
     * sudo is not available, prints the exact block to paste instead of
     * pretending. One paste beats a day of guessing.
     * =================================================================== */
    {
        key: "tailscale",
        name: "Tailscale — reach the node from anywhere",
        why: "The node stops being a thing on your LAN and becomes a thing you " +
             "can reach from a coffee shop, with no port forwarding and no " +
             "firewall surgery. .lcl talks to it over the tailnet address the " +
             "same way it talks to it at home.",
        playbook: "https://build.nvidia.com/spark/tailscale",
        takes: "15-30 minutes for initial setup, 5 minutes per additional device",
        serves: "no port — it gives the node a stable tailnet name and IP",
        needs: "passwordless sudo on the node, and one browser login with a " +
               "Google/GitHub/Microsoft account",
        steps: [
            { say: "checking sudo can run without a password prompt",
              run: "sudo -A true 2>/dev/null && echo LCL-SUDO-OK || " +
                   "{ echo LCL-NO-SUDO; echo 'Passwordless sudo is off on this node, so .lcl cannot install packages for you.'; " +
                   "echo 'Paste this on the node once, then run this again:'; " +
                   "echo '  sudo apt update && sudo apt install -y curl gnupg'; " +
                   "echo '  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null'; " +
                   "echo '  curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | sudo tee /etc/apt/sources.list.d/tailscale.list'; " +
                   "echo '  sudo apt update && sudo apt install -y tailscale && sudo tailscale up'; exit 1; }" },
            { say: "making sure ssh itself stays reachable",
              run: "systemctl is-active ssh >/dev/null 2>&1 || " +
                   "sudo -A apt-get install -y openssh-server >/dev/null 2>&1 || true; " +
                   "sudo -A systemctl enable ssh --now >/dev/null 2>&1 || true; echo LCL-SSH-OK" },
            { say: "adding Tailscale's package repository",
              run: "command -v tailscale >/dev/null && echo LCL-TS-PRESENT || { " +
                   "sudo -A apt-get update -qq && " +
                   "sudo -A apt-get install -y curl gnupg >/dev/null && " +
                   "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg | " +
                   "sudo -A tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null && " +
                   "curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list | " +
                   "sudo -A tee /etc/apt/sources.list.d/tailscale.list >/dev/null; }" },
            { say: "installing tailscale",
              run: "command -v tailscale >/dev/null || { sudo -A apt-get update -qq && " +
                   "sudo -A apt-get install -y tailscale; }; tailscale version | head -1" },
            /* THE ONE STEP THAT IS THE USER'S, AND ONLY THAT ONE.
             *
             * `tailscale up` blocks on a browser login, so run non-blocking
             * and read the URL out of the daemon's own status. The operator
             * clicks once; everything either side of that click is automated.
             * A node already logged in reports Running immediately and never
             * prints a URL, which is why the URL is optional here and the
             * RUNNING state is what proves the step. */
            { say: "connecting it to your tailnet",
              run: "state() { tailscale status --json 2>/dev/null | " +
                   "tr -d ' \\n' | sed -n 's/.*\"BackendState\":\"\\([A-Za-z]*\\)\".*/\\1/p'; }; " +
                   "authurl() { tailscale status --json 2>/dev/null | " +
                   "tr -d ' \\n' | sed -n 's/.*\"AuthURL\":\"\\([^\"]*\\)\".*/\\1/p'; }; " +
                   "[ \"$(state)\" = Running ] || (sudo -A tailscale up >/dev/null 2>&1 &); " +
                   "shown=0; for i in $(seq 1 90); do " +
                   "st=$(state); u=$(authurl); " +
                   "if [ \"$st\" = Running ]; then echo LCL-TAILSCALE-UP; " +
                   "echo \"tailnet address: $(tailscale ip -4 2>/dev/null | head -1)\"; exit 0; fi; " +
                   "if [ -n \"$u\" ] && [ $shown -eq 0 ]; then shown=1; " +
                   "echo \"LCL-TS-URL $u\"; " +
                   "echo 'Open that link and sign in — this keeps waiting for you.'; fi; " +
                   "[ $((i % 15)) -eq 0 ] && echo \"still working — $((i * 2))s\"; sleep 2; done; echo LCL-TS-TIMEOUT; exit 1" }
        ],
        verify: "LCL-TAILSCALE-UP",
        after: "The node is on your tailnet. Its tailnet name and IP are printed " +
               "above — either one works as the host when you add it as a node " +
               "here, and it keeps working off your home network.",
        rollback: "sudo tailscale down, then sudo apt remove --purge tailscale"
    },

    {
        key: "llamafactory",
        name: "LLaMA Factory — fine-tuning with a UI",
        why: "Train a LoRA on your own data against a model already on the node, " +
             "then merge and serve it. The broadest of the fine-tuning " +
             "playbooks: a hundred-odd model families, and a config file rather " +
             "than a training script you have to write.",
        playbook: "https://build.nvidia.com/spark/llama-factory",
        takes: "30-60 minutes for initial setup, 1-7 hours for training depending on mode",
        serves: "no daemon — a CLI (llamafactory-cli) inside its own venv",
        needs: "~20 GB disk, python3 and git; a Hugging Face login for gated models",
        steps: [
            { say: "checking the toolchain",
              run: "command -v python3 >/dev/null && command -v git >/dev/null && " +
                   "nvidia-smi -L | head -1 || { echo LCL-NO-TOOLCHAIN; exit 1; }" },
            { say: "making a virtual environment",
              run: "test -d \"$HOME/factoryEnv\" || python3 -m venv \"$HOME/factoryEnv\"" },
            { say: "installing torch for CUDA 13 (the long part)",
              run: "\"$HOME/factoryEnv/bin/pip\" install --upgrade pip >/dev/null && " +
                   "\"$HOME/factoryEnv/bin/python\" -c 'import torch' 2>/dev/null || " +
                   "\"$HOME/factoryEnv/bin/pip\" install torch torchvision torchaudio " +
                   "--index-url https://download.pytorch.org/whl/cu130" },
            { say: "fetching LLaMA Factory",
              run: "test -d \"$HOME/LLaMA-Factory/.git\" || git clone --depth 1 " +
                   "https://github.com/hiyouga/LLaMA-Factory.git \"$HOME/LLaMA-Factory\"" },
            { say: "installing it with metrics support",
              run: "cd \"$HOME/LLaMA-Factory\" && \"$HOME/factoryEnv/bin/pip\" install -e \".[metrics]\"" },
            { say: "checking torch really sees the GPU",
              run: "\"$HOME/factoryEnv/bin/python\" -c " +
                   "\"import torch;assert torch.cuda.is_available();print('LCL-FACTORY-READY',torch.__version__)\"" }
        ],
        verify: "LCL-FACTORY-READY",
        after: "Ready. On the node:\n" +
               "  source ~/factoryEnv/bin/activate && cd ~/LLaMA-Factory\n" +
               "  llamafactory-cli train examples/train_lora/qwen3_lora_sft.yaml\n" +
               "Copy that YAML and point it at your own dataset. `llamafactory-cli " +
               "chat` tries the result, `llamafactory-cli export` merges the LoRA " +
               "back into a servable model.",
        rollback: "rm -rf ~/LLaMA-Factory ~/factoryEnv"
    },

    {
        key: "unsloth",
        name: "Unsloth — the light fine-tune",
        why: "The fastest way to teach a model something small: single-GPU LoRA " +
             "in far less memory than a full fine-tune. Runs inside NVIDIA's " +
             "own PyTorch container, so nothing is installed on the host.",
        playbook: "https://build.nvidia.com/spark/unsloth",
        takes: "30-60 minutes for initial setup and test run",
        serves: "no daemon — a container you drop into",
        needs: "Docker with the NVIDIA runtime; ~25 GB for the container image",
        steps: [
            DOCKER_GPU,
            { say: "pulling NVIDIA's PyTorch container (this is the long part)",
              run: "docker image inspect nvcr.io/nvidia/pytorch:25.11-py3 >/dev/null 2>&1 || " +
                   "docker pull nvcr.io/nvidia/pytorch:25.11-py3" },
            /* Baked into a LAYER, not installed per-run. The playbook installs
             * these inside an interactive container, which means every session
             * pays for the install again and a disconnect loses it. */
            { say: "building the unsloth layer on top of it",
              run: "printf '%s\\n' " +
                   "'FROM nvcr.io/nvidia/pytorch:25.11-py3' " +
                   "'RUN pip install transformers peft hf_transfer \"datasets==4.3.0\" \"trl==0.26.1\"' " +
                   "'RUN pip install --no-deps unsloth unsloth_zoo bitsandbytes' " +
                   "> /tmp/lcl-unsloth.Dockerfile && " +
                   "docker build -t lcl/unsloth:25.11 -f /tmp/lcl-unsloth.Dockerfile /tmp" },
            { say: "proving it imports and sees the GPU",
              run: "docker run --rm --gpus all --ulimit memlock=-1 --ulimit stack=67108864 " +
                   "lcl/unsloth:25.11 python -c " +
                   "\"import torch,unsloth;assert torch.cuda.is_available();print('LCL-UNSLOTH-READY')\"" }
        ],
        verify: "LCL-UNSLOTH-READY",
        after: "Ready. Drop into it on the node with:\n" +
               "  docker run --gpus all --ulimit memlock=-1 --ulimit stack=67108864 \\\n" +
               "    -v $HOME/.cache/huggingface:/root/.cache/huggingface \\\n" +
               "    -it --rm lcl/unsloth:25.11 bash\n" +
               "NVIDIA's smoke test is test_unsloth.py in the playbook assets.",
        rollback: "docker rmi lcl/unsloth:25.11 nvcr.io/nvidia/pytorch:25.11-py3"
    },

    {
        key: "txt2kg",
        name: "txt2kg — knowledge graphs from text",
        why: "The one thing .lcl's knowledge subsystem cannot do. It embeds and " +
             "cites passages; this turns a pile of documents into a GRAPH of " +
             "entities and relations you can query. Runs entirely on the node.",
        playbook: "https://build.nvidia.com/spark/txt2kg",
        takes: "2-3 minutes for initial setup and container deployment",
        serves: "web UI on port 3001 · ArangoDB on 8529 · its own Ollama on 11434",
        // no endpoint: a web UI and a graph database; its Ollama is the ollama recipe's port
        noEndpoint: "a web UI and a graph database; its Ollama is the ollama recipe's port",
        needs: "Docker with compose and the NVIDIA runtime; ~30 GB",
        steps: [
            { say: "checking Docker compose and the GPU runtime",
              run: "docker compose version >/dev/null 2>&1 && " +
                   "docker info 2>/dev/null | grep -qi nvidia || " +
                   "{ echo LCL-NO-COMPOSE-OR-RUNTIME; exit 1; }" },
            DOCKER_GPU,
            { say: "fetching the playbook assets",
              run: "test -d \"$HOME/dgx-spark-playbooks/.git\" || git clone --depth 1 " +
                   "https://github.com/NVIDIA/dgx-spark-playbooks \"$HOME/dgx-spark-playbooks\"" },
            { say: "starting the stack (it pulls several images)",
              run: "cd \"$HOME/dgx-spark-playbooks/nvidia/txt2kg/assets\" && " +
                   "chmod +x ./start.sh && ./start.sh" },
            { say: "waiting for the web UI to answer",
              run: "for i in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:3001 >/dev/null && " +
                   "{ echo LCL-TXT2KG-UP; exit 0; }; [ $((i % 10)) -eq 0 ] && echo \"still working — $((i * 3))s\"; sleep 3; done; echo LCL-TXT2KG-NOT-UP; exit 1" }
        ],
        verify: "LCL-TXT2KG-UP",
        after: "Open http://<node>:3001 to build a graph. Its Ollama is separate " +
               "from any you already run — pull a model into it with:\n" +
               "  docker exec ollama-compose ollama pull llama3.1:8b",
        rollback: "cd ~/dgx-spark-playbooks/nvidia/txt2kg/assets && docker compose down -v"
    },

    {
        key: "portfolio",
        name: "GPU portfolio optimization",
        why: "RAPIDS on the node: cuDF, cuPy and Dask doing numerical work that " +
             "is hopeless on a CPU. The playbook frames it as portfolio " +
             "optimisation; the machinery underneath is general GPU dataframes " +
             "and solvers, which is the half of the box .lcl otherwise ignores.",
        playbook: "https://build.nvidia.com/spark/portfolio-optimization",
        takes: "~20 minutes for first run",
        serves: "dashboard on 8050 · Streamlit on 8501 · Jupyter on 8888 · Dask on 8787",
        needs: "Docker with the NVIDIA runtime; ~20 GB",
        steps: [
            DOCKER_GPU,
            { say: "fetching the playbook assets",
              run: "test -d \"$HOME/dgx-spark-playbooks/.git\" || git clone --depth 1 " +
                   "https://github.com/NVIDIA/dgx-spark-playbooks \"$HOME/dgx-spark-playbooks\"" },
            { say: "starting it (this pulls the RAPIDS image)",
              run: "cd \"$HOME/dgx-spark-playbooks/nvidia/portfolio-optimization/assets\" && " +
                   "bash ./setup/start_playbook.sh" },
            { say: "waiting for the dashboard",
              run: "for i in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8050 >/dev/null && " +
                   "{ echo LCL-PORTFOLIO-UP; exit 0; }; [ $((i % 10)) -eq 0 ] && echo \"still working — $((i * 3))s\"; sleep 3; done; " +
                   "echo LCL-PORTFOLIO-NOT-UP; exit 1" }
        ],
        verify: "LCL-PORTFOLIO-UP",
        after: "Dashboard on http://<node>:8050, notebooks on :8888. The " +
               "notebooks are the useful part — they are worked cuDF/cuPy " +
               "examples you can point at your own data.",
        rollback: "cd ~/dgx-spark-playbooks/nvidia/portfolio-optimization/assets && " +
                  "docker compose down -v"
    },

    {
        key: "specdecode",
        name: "Speculative decoding — same weights, more tokens per second",
        why: "A small draft model proposes, the big one checks. Nothing about " +
             "the answer changes; it just arrives faster. This is the honest " +
             "answer to \"0.9 tokens per second\" once the context window is " +
             "already right.",
        playbook: "https://build.nvidia.com/spark/speculative-decoding",
        takes: "10-20 minutes for setup, plus model downloads",
        serves: "OpenAI-compatible API on port 8000 (trtllm-serve)",
        endpoint: { port: 8000, path: "/v1", shape: "openai" },
        needs: "Docker with the NVIDIA runtime, a Hugging Face token, and ~150 GB " +
               "for gpt-oss-120b plus its Eagle3 draft head",
        /* WHAT IS AUTOMATED AND WHAT IS NOT, DELIBERATELY.
         *
         * The image pull is long, safe and idempotent, so .lcl does it. The
         * SERVE command downloads ~150 GB of gated weights under the
         * operator's own Hugging Face identity and then occupies the GPU
         * indefinitely — that is a decision with the operator's name on it, not
         * a button. The exact command is handed over complete so it is one paste. */
        steps: [
            DOCKER_GPU,
            { say: "checking there is room for the weights",
              run: "free=$(df -Pk \"$HOME\" | awk 'NR==2{print int($4/1048576)}'); " +
                   "echo \"free: ${free} GB\"; [ \"$free\" -ge 170 ] || " +
                   "{ echo LCL-NOT-ENOUGH-DISK; exit 1; }" },
            { say: "pulling the TensorRT-LLM release image (very long)",
              run: "docker image inspect nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc12 " +
                   ">/dev/null 2>&1 || docker pull nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc12" },
            { say: "confirming the runtime starts",
              run: "docker run --rm --gpus all nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc12 " +
                   "python -c \"import tensorrt_llm;print('LCL-SPECDEC-READY')\" 2>/dev/null || " +
                   "{ echo LCL-SPECDEC-IMAGE-BAD; exit 1; }" }
        ],
        verify: "LCL-SPECDEC-READY",
        after: "The runtime is on the node. Serving downloads ~150 GB under your " +
               "own Hugging Face account and holds the GPU, so that command is " +
               "yours to run, complete, once:\n\n" +
               "  export HF_TOKEN=<your token>\n" +
               "  docker run -e HF_TOKEN=$HF_TOKEN \\\n" +
               "    -v $HOME/.cache/huggingface/:/root/.cache/huggingface/ \\\n" +
               "    --rm -it --ulimit memlock=-1 --ulimit stack=67108864 \\\n" +
               "    --gpus=all --ipc=host --network host \\\n" +
               "    nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc12 \\\n" +
               "    bash -c 'hf download openai/gpt-oss-120b && \\\n" +
               "      hf download nvidia/gpt-oss-120b-Eagle3-long-context \\\n" +
               "        --local-dir /opt/gpt-oss-120b-Eagle3/ && \\\n" +
               "      trtllm-serve openai/gpt-oss-120b --backend pytorch \\\n" +
               "        --tp_size 1 --max_batch_size 1'\n\n" +
               "It answers on port 8000 in the OpenAI shape, so add it here as " +
               "an ordinary endpoint once it is up. The Eagle3 draft settings " +
               "from the playbook go in --extra_llm_api_options.",
        rollback: "docker rmi nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc12"
    },

    /* =====================================================================
     * ...AND THEN IT HAS TO BE REACHABLE FROM THE CHAT BOX.
     *
     * The reason .lcl exists: installing a pile of things is not the same as
     * making them work together and reachable.
     *
     * Every recipe below that leaves a SERVER running carries an `endpoint`
     * descriptor: the port it answers on, the path prefix, and the wire shape.
     * A successful install registers it against the node it ran on, so the
     * model picker has it before the operator has finished reading the log.
     * Installing and wiring were two jobs; only one of them was being done.
     * =================================================================== */
    {
        key: "ollama",
        name: "Ollama — the simplest local server",
        why: "One command, an OpenAI-compatible API, and every GGUF on the hub. " +
             "The fastest way to make a fresh node answer at all — and the one " +
             "whose context window has to be set deliberately, or it serves 4,096 " +
             "tokens no matter what the model can do.",
        playbook: "https://build.nvidia.com/spark/ollama",
        takes: "10-15 minutes for initial setup, 2-3 minutes for model download",
        serves: "port 11434",
        needs: "nothing but the network; models are pulled on demand",
        endpoint: { port: 11434, path: "/v1", shape: "openai" },
        steps: [
            /* THE INSTALLER CALLS sudo, AND THIS TRANSPORT HAS NO TERMINAL.
             *
             * The reported failure: the Spark install said "did not finish,
             * permission denied" even though models ran fine over ssh — the
             * expectation being full remote control of the node.
             *
             * That works — interactively. sshStream runs BatchMode=yes with no
             * -t, so there is no tty for sudo to prompt on, and ollama's own
             * install.sh shells out to sudo to write /usr/local/bin. It died
             * with "permission denied" and nothing said why or what to do.
             *
             * If passwordless sudo is available, this passes straight through.
             * If it is not, it stops with the two lines to paste: the install
             * itself, and the one-time rule that lets .lcl do this unattended
             * afterwards. A refusal that hands over the fix beats one that
             * hands over a diagnosis.
             */
            { say: "checking this login can install software on the node",
              run: // NO EARLY EXIT ON THE HAPPY PATH: the steps run as ONE script under
                   // set -e, so exiting here would skip every later step —
                   // including the one that proves it answers — and an
                   // already-installed Ollama would report "did not prove
                   // itself working". Short-circuit instead.
                   "command -v ollama >/dev/null || " +
                   "sudo -A true 2>/dev/null || { " +
                   "echo LCL-NO-SUDO; " +
                   "echo 'This needs root on the node, and no password was given.'; " +
                   "echo 'Type your password for this node in the box on the Run panel, then run it again.'; " +
                   "echo; " +
                   "echo 'It is used to unlock sudo for the run and is not saved.'; " +
                   "echo; " +
                   "echo 'If you would rather .lcl never asked, this makes sudo passwordless here:'; " +
                   "RULE=$USER\\ ALL=\\(ALL\\)\\ NOPASSWD:ALL; " +
                   "printf '  echo %s | sudo tee /etc/sudoers.d/lcl-%s\\n' \"$RULE\" \"$USER\"; " +
                   "exit 1; }; echo LCL-SUDO-CHECKED" },
            { say: "installing ollama if it is not already there",
              run: "command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh" },
            { say: "checking it answers",
              run: "for i in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:11434/api/tags " +
                   ">/dev/null && { echo LCL-OLLAMA-UP; exit 0; }; [ $((i % 15)) -eq 0 ] && echo \"still working — $((i * 2))s\"; sleep 2; done; " +
                   "echo LCL-OLLAMA-NOT-UP; exit 1" }
        ],
        verify: "LCL-OLLAMA-UP",
        after: "Registered as an endpoint on this node. Pull a model from the " +
               "model library, or on the node with `ollama pull <name>`.\n\n" +
               "Set OLLAMA_CONTEXT_LENGTH on the machine before you rely on a " +
               "big model: Ollama serves 4,096 tokens by default whatever the " +
               "model supports, which is why a 70B can answer a repository-sized " +
               "question having read almost none of it.",
        rollback: "sudo systemctl disable --now ollama, then remove /usr/local/bin/ollama"
    },

    {
        key: "sglang",
        name: "SGLang — high-throughput serving",
        why: "The other serious server beside vLLM: RadixAttention reuses the " +
             "prefix of every request, which is exactly the shape of a long chat " +
             "session that re-sends its history each turn. OpenAI-compatible, so " +
             ".lcl needs no change to drive it.",
        playbook: "https://build.nvidia.com/spark/sglang",
        takes: "30 minutes for initial setup and validation",
        serves: "port 30000",
        needs: "Docker with the NVIDIA runtime; ~30 GB for the image",
        endpoint: { port: 30000, path: "/v1", shape: "openai" },
        steps: [
            DOCKER_GPU,
            { say: "pulling the SGLang image (long)",
              run: "docker image inspect lmsysorg/sglang:latest-cu130 >/dev/null 2>&1 || " +
                   "docker pull lmsysorg/sglang:latest-cu130" },
            { say: "confirming it starts and sees the GPU",
              run: "docker run --rm --gpus all lmsysorg/sglang:latest-cu130 " +
                   "nvidia-smi -L >/dev/null 2>&1 && echo LCL-SGLANG-READY || " +
                   "{ echo LCL-SGLANG-BAD; exit 1; }" }
        ],
        verify: "LCL-SGLANG-READY",
        after: "The runtime is ready. Serving pins one model and holds the GPU, " +
               "so that command is yours:\n\n" +
               "  docker run --gpus all --ipc=host --network host \\\n" +
               "    -v $HOME/.cache/huggingface:/root/.cache/huggingface \\\n" +
               "    lmsysorg/sglang:latest-cu130 python3 -m sglang.launch_server \\\n" +
               "      --model-path <model> --port 30000 --host 0.0.0.0\n\n" +
               "Set --context-length to the window you actually want; like vLLM " +
               "it is fixed at launch.",
        rollback: "docker rmi lmsysorg/sglang:latest-cu130"
    },

    {
        key: "lmstudio",
        name: "LM Studio — headless server",
        why: "A model manager with an OpenAI-compatible server and a real " +
             "catalogue behind it. `lms server start` on the node and .lcl talks " +
             "to it like any other endpoint.",
        playbook: "https://build.nvidia.com/spark/lm-studio",
        takes: "15-30 minutes, including the model download",
        serves: "port 1234",
        needs: "~2 GB for the runtime, plus whatever models you load",
        endpoint: { port: 1234, path: "/v1", shape: "openai" },
        steps: [
            { say: "installing the LM Studio CLI if it is not there",
              run: "command -v lms >/dev/null || curl -fsSL https://lmstudio.ai/install.sh | bash" },
            { say: "starting its server on every interface",
              run: "export PATH=\"$HOME/.lmstudio/bin:$PATH\"; " +
                   "lms server start --bind 0.0.0.0 --port 1234 >/dev/null 2>&1 || true" },
            { say: "checking it answers",
              run: "for i in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:1234/v1/models " +
                   ">/dev/null && { echo LCL-LMSTUDIO-UP; exit 0; }; [ $((i % 15)) -eq 0 ] && echo \"still working — $((i * 2))s\"; sleep 2; done; " +
                   "echo LCL-LMSTUDIO-NOT-UP; exit 1" }
        ],
        verify: "LCL-LMSTUDIO-UP",
        after: "Registered as an endpoint. Load a model on the node with " +
               "`lms load <model>` — LM Studio serves whatever is loaded.",
        rollback: "lms server stop, then remove ~/.lmstudio"
    },

    {
        key: "openwebui",
        name: "Open WebUI — a browser front end for the node",
        why: "Not a competitor to .lcl: it is the thing to hand someone else in " +
             "the house, and a second opinion when you want to know whether a " +
             "problem is the model or the client. Ships with its own Ollama.",
        playbook: "https://build.nvidia.com/spark/open-webui",
        takes: "15-20 minutes, including the container download",
        serves: "port 3000 (web) · its own Ollama on 11434",
        // no endpoint: a web UI; its Ollama is the ollama recipe's port
        noEndpoint: "a web UI; its Ollama is the ollama recipe's port",
        needs: "Docker with the NVIDIA runtime; ~10 GB",
        steps: [
            DOCKER_GPU,
            { say: "pulling the image (long)",
              run: "docker image inspect ghcr.io/open-webui/open-webui:ollama >/dev/null 2>&1 || " +
                   "docker pull ghcr.io/open-webui/open-webui:ollama" },
            { say: "starting it, and keeping it up across reboots",
              run: "docker rm -f open-webui >/dev/null 2>&1 || true; " +
                   "docker run -d --name open-webui --restart unless-stopped " +
                   "--gpus all -p 3000:8080 -p 11434:11434 " +
                   "-v open-webui:/app/backend/data " +
                   "ghcr.io/open-webui/open-webui:ollama" },
            { say: "waiting for it to answer",
              run: "for i in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:3000 >/dev/null && " +
                   "{ echo LCL-OPENWEBUI-UP; exit 0; }; [ $((i % 10)) -eq 0 ] && echo \"still working — $((i * 3))s\"; sleep 3; done; " +
                   "echo LCL-OPENWEBUI-NOT-UP; exit 1" }
        ],
        verify: "LCL-OPENWEBUI-UP",
        after: "Browser UI on http://<node>:3000. Its Ollama is registered here " +
               "as an endpoint too, so both front ends drive the same models.",
        rollback: "docker rm -f open-webui && docker volume rm open-webui"
    },

    {
        key: "nim",
        name: "NIM — NVIDIA's own optimised microservice",
        why: "NVIDIA's tuned serving container for its own hardware: the fastest " +
             "supported path on this box, and OpenAI-compatible. Needs an NGC " +
             "account, which is why the login step is yours.",
        playbook: "https://build.nvidia.com/spark/nim-llm",
        takes: "15-30 minutes for setup and validation",
        serves: "port 8000",
        needs: "Docker with the NVIDIA runtime, an NGC API key, and ~60 GB",
        endpoint: { port: 8000, path: "/v1", shape: "openai" },
        steps: [
            DOCKER_GPU,
            { say: "checking you are logged in to NVIDIA's registry",
              run: "grep -q nvcr.io \"$HOME/.docker/config.json\" 2>/dev/null && " +
                   "echo LCL-NGC-LOGGED-IN || { echo LCL-NGC-NOT-LOGGED-IN; " +
                   "echo 'Log in once on the node, then run this again:'; " +
                   "echo '  echo $NGC_API_KEY | docker login nvcr.io -u \\$oauthtoken --password-stdin'; " +
                   "exit 1; }" },
            { say: "checking there is room for a NIM image",
              run: "free=$(df -Pk \"$HOME\" | awk 'NR==2{print int($4/1048576)}'); " +
                   "echo \"free: ${free} GB\"; [ \"$free\" -ge 70 ] || " +
                   "{ echo LCL-NOT-ENOUGH-DISK; exit 1; }" },
            { say: "confirming the CUDA base runs here",
              run: "docker run --rm --gpus all nvcr.io/nvidia/cuda:13.0.1-devel-ubuntu24.04 " +
                   "nvidia-smi -L >/dev/null 2>&1 && echo LCL-NIM-READY || " +
                   "{ echo LCL-NIM-BAD; exit 1; }" }
        ],
        verify: "LCL-NIM-READY",
        after: "The box is ready and logged in. Pick a NIM from " +
               "build.nvidia.com and run it — it serves the OpenAI shape on " +
               "8000, which is already registered here as an endpoint:\n\n" +
               "  docker run -d --name nim-llm --gpus all --shm-size=16g \\\n" +
               "    -e NGC_API_KEY -v $HOME/.cache/nim:/opt/nim/.cache \\\n" +
               "    -p 8000:8000 nvcr.io/nim/<publisher>/<model>:latest",
        rollback: "docker rm -f nim-llm, then delete ~/.cache/nim"
    },

    {
        key: "jax",
        name: "JAX — array maths on the GPU",
        why: "The other half of the box: differentiable numerical code, compiled. " +
             "For signal and array work that is not a language model at all — " +
             "which is most of what scientific computing actually needs.",
        playbook: "https://build.nvidia.com/spark/jax",
        takes: "2-3 hours including setup, tutorial completion, and validation",
        serves: "no daemon — a container image you drop into",
        needs: "Docker with the NVIDIA runtime; ~15 GB",
        steps: [
            DOCKER_GPU,
            { say: "fetching the playbook assets",
              run: "test -d \"$HOME/dgx-spark-playbooks/.git\" || git clone --depth 1 " +
                   "https://github.com/NVIDIA/dgx-spark-playbooks \"$HOME/dgx-spark-playbooks\"" },
            { say: "building the JAX image (long)",
              run: "cd \"$HOME/dgx-spark-playbooks/nvidia/jax/assets\" && " +
                   "docker build -t jax-on-spark ." },
            { say: "proving it sees the GPU",
              run: "docker run --rm --gpus all jax-on-spark python -c " +
                   "\"import jax;print(jax.devices()[0].platform)\" | grep -q gpu " +
                   "&& echo LCL-JAX-READY || { echo LCL-JAX-NO-GPU; exit 1; }" }
        ],
        verify: "LCL-JAX-READY",
        after: "Drop into it with:\n  docker run --gpus all -it --rm " +
               "-v $PWD:/work -w /work jax-on-spark bash",
        rollback: "docker rmi jax-on-spark"
    },

    /* ---- read the playbook first: .lcl does not install these ---- */
    {
        key: "isaac",
        name: "Isaac Sim + Isaac Lab",
        why: "The only playbook that touches simulation and motion rather " +
             "than the AI side — robotics simulation and reinforcement learning " +
             "on the same box.",
        playbook: "https://build.nvidia.com/spark/isaac",
        needs: "tens of GB, and an NVIDIA account for the assets",
        manual: "Isaac Sim is a large simulator with its own licence acceptance " +
                "and asset downloads. .lcl does not install it, because a " +
                "multi-gigabyte install with a licensing flow deserves your eyes " +
                "on it rather than a button in someone else's app."
    },
    {
        key: "openshell",
        name: "OpenShell — sandboxed agents",
        why: "A sandbox for agents that actually run commands. Directly relevant " +
             "to the Docker/WSL execution tier .lcl still has open.",
        playbook: "https://build.nvidia.com/spark/openshell",
        needs: "Docker",
        manual: "A security tool's setup is worth reading before running — and " +
                "NVIDIA now ships a supported one-command installer for exactly " +
                "this: the nemoclaw playbook (build.nvidia.com/spark/nemoclaw) " +
                "stands OpenShell up wired to local vLLM, from an nvidia.com " +
                "URL. Read that playbook; it is the supported way in. What " +
                "OpenShell does remains the model .lcl's own sandbox tier " +
                "should follow."
    }
];

/* WHAT A RECIPE *IS*, which is not the same question as what it installs.
 *
 * The design idea: rather than making vLLM its own selector when a local node
 * has it available, make it a session-based toggle — the local node model on
 * llama.cpp runs the larger context and invokes agents running on vLLM, so the
 * llama.cpp model on the node orchestrates the other tools available there.
 *
 * That is the right call, and the picker was wrong. Twenty-one recipes were sorted into
 * exactly two bins — "has an endpoint" and "does not" — so vLLM, which exists
 * to serve twenty agents at once, arrived in the model picker as one more
 * thing to chat with, beside llama.cpp, which exists to serve one. Picking
 * between them is not a choice anyone should be asked to make: they do
 * different jobs and the right answer is BOTH, at once, with the session
 * model orchestrating and the fleet doing the parallel work.
 *
 *   chat     ONE stream, the biggest window, the model the operator talks to.
 *            This is what a session selects, and the only thing it selects.
 *   fleet    MANY streams. Continuous batching, so twenty agents cost far
 *            less than twenty times one. Assigned per session, never picked
 *            as "the model".
 *   service  A daemon that is not a chat API at all — images, a camera, a
 *            graph. A capability the session model can reach for.
 *   toolkit  No daemon. A library, a CLI, a container to drop into. Nothing
 *            to point at, nothing resident, and safe to install beside
 *            anything else.
 *   infra    The node itself — networking, reachability.
 *
 * `holds` is the other half, and it is the one that answers "will this crash
 * my Spark": TRUE means the thing sits on the GPU for its whole life. Three
 * engines that each hold cannot share 121 GiB, and the install wizard can say
 * so BEFORE the download rather than after the ValueError.
 *
 * A TABLE, not a field on each recipe, so the whole shape is readable in one
 * screen — and `tests/node-roles.js` fails if a recipe is added without a
 * line here, which is the drift a separate table would otherwise invite. */
const ROLES = {
    // one stream, big window — the orchestrator seat
    llamacpp:     { role: "chat", ports: [30000],    holds: true },
    "driver-llamacpp-gptoss120b": { role: "chat", ports: [30000], holds: true },
    ollama:       { role: "chat", ports: [11434],    holds: true },
    lmstudio:     { role: "chat", ports: [1234],    holds: true },
    coder:        { role: "chat", ports: [11434],    holds: true },
    // many streams — the agent fleet
    vllm:         { role: "fleet", ports: [8000],   holds: true },
    "fleet-vllm-gptoss20b": { role: "fleet", ports: [8000],  holds: true },
    sglang:       { role: "fleet", ports: [30000],   holds: true },
    specdecode:   { role: "fleet", ports: [8000],   holds: true },
    nim:          { role: "fleet", ports: [8000],   holds: true },
    // a daemon that is not a chat API: a capability, reached for by name
    comfyui:      { role: "service", ports: [8188], holds: true,  capability: "images" },
    vlm:          { role: "service", ports: [8090], holds: true,  capability: "vision" },
    txt2kg:       { role: "service", ports: [3001, 8529], holds: true,  capability: "knowledge graphs" },
    portfolio:    { role: "service", ports: [8050, 8501, 8888, 8787], holds: true,  capability: "analysis" },
    openshell:    { role: "service", ports: [], holds: false, capability: "sandboxed agents" },
    openwebui:    { role: "service", ports: [3000], holds: false, capability: "a browser front end" },
    // no daemon: nothing resident, nothing to point at, safe beside anything
    nvfp4:        { role: "toolkit", ports: [], holds: false },
    cutile:       { role: "toolkit", ports: [], holds: false },
    llamafactory: { role: "toolkit", ports: [], holds: false },
    unsloth:      { role: "toolkit", ports: [], holds: false },
    jax:          { role: "toolkit", ports: [], holds: false },
    isaac:        { role: "toolkit", ports: [], holds: false },
    // the node itself
    tailscale:    { role: "infra", ports: [],   holds: false }
};

/* WHAT IS ON THAT MACHINE — ASKED, NOT REMEMBERED.
 *
 * The reported gap: the list for a device does not resolve when a playbook is
 * installed.
 *
 * Nothing records what a node has installed, and a record would be the wrong
 * answer anyway: it would know only about installs .lcl performed, and would go
 * stale the moment something was stopped, removed, or put there by hand. The
 * machine already knows. One `ss -ltn` names every port listening on it, and an
 * open port is a server that is RUNNING — which is the question all three
 * callers actually have:
 *
 *   - what would a new install fight for memory with            (contendersFor)
 *   - what does this device offer a session                     (capability rows)
 *   - what is on it at all                                      (its own card)
 *
 * Ports are not unique — 8000 is vLLM, spec-decode and NIM; 30000 is llama.cpp
 * and SGLang — so an open port can mean more than one recipe, and this returns
 * all of them rather than picking a favourite. For the memory question the
 * ambiguity does not matter: whichever it is, it is holding the GPU.
 */
function presentFrom(openPorts) {
    const open = new Set((openPorts || []).map(Number).filter(p => p > 0));
    return STACKS
        .filter(st => (roleOf(st.key).ports || []).some(p => open.has(Number(p))))
        .map(st => {
            const r = roleOf(st.key);
            return { key: st.key, name: st.name, role: r.role, holds: !!r.holds,
                     capability: r.capability || null,
                     ports: (r.ports || []).filter(p => open.has(Number(p))) };
        });
}

/** Every port any recipe could be listening on — what to look for on a node. */
function knownPorts() {
    const all = new Set();
    for (const st of STACKS) {
        for (const p of (roleOf(st.key).ports || [])) all.add(Number(p));
    }
    return [...all].sort((a, b) => a - b);
}

/** What this recipe is, for a UI that has to tell one kind from another. */
function roleOf(key) {
    return ROLES[String(key || "")] || { role: "toolkit", holds: false };
}

/** Every recipe of a kind — the picker asks for "chat", the fleet slot "fleet". */
function ofRole(role) {
    return STACKS.filter(s => roleOf(s.key).role === role);
}

/* WHAT IS ALREADY SITTING ON THIS NODE'S MEMORY.
 *
 * The concern: installing more things on a node risks crashing it when it is
 * already at almost full usage with vLLM running.
 *
 * A well-founded concern, and the app knew the answer the whole time: it has
 * the table, and the table says which recipes hold memory for their whole
 * life. Given what a node has installed, this names what a new install would
 * be competing with — so the wizard can say it before the several-GB pull
 * rather than after the launch fails. */
function contendersFor(key, installedKeys) {
    if (!roleOf(key).holds) return [];
    return (installedKeys || [])
        .filter(k => k !== key && roleOf(k).holds)
        .map(k => { const s = get(k); return { key: k, name: (s && s.name) || k,
                                               role: roleOf(k).role }; });
}

function get(key) { return STACKS.find(s => s.key === String(key || "")) || null; }
function installable(key) {
    const s = get(key);
    return !!(s && Array.isArray(s.steps) && s.steps.length);
}
/** Everything that will be run, for the operator to read BEFORE it runs. */
function preview(key) {
    const s = get(key);
    if (!s || !s.steps) return [];
    return s.steps.map(st => ({ say: st.say, run: st.run }));
}
/** The steps as one shell script — `set -e`, so a failure stops the rest. */
function script(key) {
    const s = get(key);
    if (!s || !s.steps) return null;
    return "set -e\n" + s.steps
        .map(st => `echo "LCL-STEP ${st.say}"\n${st.run}`)
        .join("\n") + "\n";
}

module.exports = { STACKS, get, installable, preview, script,
                   ROLES, roleOf, ofRole, contendersFor,
                   presentFrom, knownPorts };
