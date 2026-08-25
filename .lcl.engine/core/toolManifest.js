/**
 * THE TOOL MANIFEST — and the one thing it exists to make possible.
 *
 * A small local model given an underspecified job does one of two bad things:
 * it refuses ("I cannot create 3D models"), or it guesses and produces
 * confident nonsense. Neither is what a capable colleague does. A colleague
 * says: "I can do that — I need a few dimensions. Want me to start with a
 * 20 mm cube so you can see the shape of it, or will you give me details?"
 *
 * That reply is not a failure mode to be handled. It is a FIRST-CLASS ACTION,
 * so it needs to be something the model can legally emit:
 *
 *     {"tool": "clarify", "args": {"question": "...", "offer": "..."}}
 *
 * Once asking is a legal move, refusing and guessing stop being the only two
 * options in the model's head. That is the whole design.
 *
 * The manifest is pure data — no requires, no side effects — for the same
 * reason a grammar is: it must be usable to generate the prompt the model
 * reads AND, later, the constrained-decoding grammar it emits against. Two
 * descriptions of the same tool always drift; one cannot.
 */

/**
 * DEFAULT OFFERS. When a request is too vague to execute, this is the concrete
 * thing the model may propose instead of asking an open question. "Want a cube
 * to start?" is answerable in one word; "please provide your requirements" is
 * a form to fill in, and users abandon forms.
 */
const DEFAULT_OFFERS = {
    build_model: "a 20 mm cube, so you can see the output format",
    draw_schematic: "a labelled 1k/3k voltage divider on an A4 sheet",
    capture_drawing: "a capture of the drawing image you name, with its uncertain reads flagged",
    redline_drawing: "a list of the changes you dictate, applied one revision at a time",
    simulate_circuit: "a DC operating point on the circuit as drawn",
    generate_image: "a quick 512x512 draft",
    research_topic: "the top 3 sources, so you can see what is out there"
};

/**
 * Tools whose job is ambiguous without parameters. Naming them is what lets
 * the agent notice "this needs constraints" BEFORE the model has to work it
 * out for itself — a 4B will not reliably reach that conclusion unaided.
 */
const NEEDS_CONSTRAINTS = new Set(Object.keys(DEFAULT_OFFERS));

/**
 * The clarify action itself. Deliberately NOT in the tool registry: it
 * executes nothing, touches nothing and needs no permission. It is a way of
 * REPLYING, routed by the agent straight back to the user.
 */
const CLARIFY = {
    name: "clarify",
    summary: "Ask for the missing details instead of guessing — and offer a concrete starting point",
    args: [
        { name: "question", required: true,
          description: "the specific thing you need to know, in one sentence" },
        { name: "offer", required: false,
          description: "a concrete default you could do right now instead, so the user can just say yes" },
        // CHOICES turn "answer me in prose" into one click. A question waiting on
        // free text stalls until the user reads it, understands it, and types; a
        // question with three buttons is answered in a second from a notification.
        // Free text stays available underneath — the choices are a shortcut, never
        // a cage, because the model's three guesses are often all wrong.
        { name: "choices", required: false,
          description: "2-5 short concrete options the user can pick with one click, " +
                       "as an array of strings. Offer these whenever the answer is a " +
                       "choice rather than an explanation." }
    ],
    example: '{"tool": "clarify", "args": {"question": "What overall dimensions, and does it need a bore?", ' +
             '"choices": ["20 mm cube, no bore", "20 mm cube, 6 mm bore", "tell me the dimensions"], ' +
             '"offer": "a 20 mm cube, so you can see the output format"}}',
    when: "the request is real and you CAN do it, but a detail you need was not given"
};

/**
 * The prompt fragment that teaches the behaviour.
 *
 * Written as rules about what to DO, because small models follow instructions
 * about output far better than they follow assertions about capability. The
 * "never say you cannot" line is load-bearing: the observed failure was models
 * refusing work the tools plainly supported.
 */
function clarifyPrompt(availableTools = []) {
    const relevant = availableTools.filter(t => NEEDS_CONSTRAINTS.has(t));
    if (!relevant.length) return "";
    const offers = relevant
        .map(t => `  - ${t}: ${DEFAULT_OFFERS[t]}`)
        .join("\n");
    return (
        "\nWHEN A REQUEST IS MISSING DETAILS — ask, do not guess and do not refuse.\n" +
        "You have real tools for this work, so the answer is never 'I cannot'. If a " +
        "request is genuinely doable but underspecified, reply with a clarify block:\n\n" +
        "```tool\n" + CLARIFY.example + "\n```\n\n" +
        "Ask ONE question — the detail that actually blocks you — and offer something " +
        "concrete you could do immediately, so the user can answer with a single word. " +
        "Sensible starting points:\n" + offers + "\n" +
        "If the user then says yes, just do it. If they give details, use those instead.\n"
    );
}

/**
 * Did the model ask for clarification? Recognised from a parsed tool call.
 * Returns the question and offer, or null.
 */
function parseClarify(call) {
    if (!call || call.tool !== "clarify") return null;
    const args = call.args || {};
    const question = String(args.question || args.ask || "").trim();
    if (!question) return null;
    // Choices are normalised hard: models emit them as arrays, as
    // comma-joined strings, and as objects with a label. All three become a
    // short list of plain strings, or nothing.
    let choices = args.choices || args.options || null;
    if (typeof choices === "string") choices = choices.split(/\s*[|;]\s*/);
    if (!Array.isArray(choices)) choices = null;
    if (choices) {
        choices = choices
            .map(c => String((c && c.label) || c || "").trim().slice(0, 80))
            .filter(Boolean)
            .slice(0, 5);
        if (choices.length < 2) choices = null;   // one "choice" is not a choice
    }
    return {
        question: question.slice(0, 400),
        offer: String(args.offer || args.default || "").trim().slice(0, 300) || null,
        choices
    };
}

/** The message shown to the user when the model asks. */
function renderClarify(c) {
    if (!c) return "";
    return c.offer
        ? `${c.question}\n\nIf it's easier, I can start with ${c.offer} — just say go.`
        : c.question;
}

/**
 * Structured descriptions for tools where the ARGUMENTS are the hard part.
 * Only tools that genuinely benefit are listed; everything else keeps its
 * existing one-line help, because padding the prompt with obvious detail costs
 * context and buys nothing.
 */
const ARG_DETAIL = {
    /* THE TOOLS THE AGENT ACTUALLY LIVES ON.
     *
     * These had no entry here, because the TEXT protocol carries their
     * arguments in the help line and that was the only consumer. Native tool
     * calling reads THIS table, so without them every file tool went over the
     * wire as a zero-argument function — and a host that constrains output to
     * the schema then emits {} and the call fails: "write_file needs the file
     * body". Advertising a tool with no arguments is worse than not
     * advertising it, so they are described here, once, for both protocols. */
    web_search: {
        schemaOnly: true,
        summary: "Search the web and read what comes back.",
        args: [
            { name: "query", required: true, description: "what you want to find out" },
        ]
    },
    http_fetch: {
        schemaOnly: true,
        summary: "Fetch one URL and return its text.",
        args: [
            { name: "url", required: true, description: "the full https:// address" },
        ]
    },
    knowledge_search: {
        schemaOnly: true,
        summary: "Search the user's own knowledge library.",
        args: [
            { name: "query", required: true, description: "what you are looking for" },
        ]
    },
    semantic_search: {
        schemaOnly: true,
        summary: "Search the linked folder by MEANING rather than exact text.",
        args: [
            { name: "query", required: true, description: "describe what you want, e.g. \"where sessions get saved\"" },
        ]
    },
    calculate: {
        schemaOnly: true,
        summary: "Do arithmetic exactly, instead of guessing at it.",
        args: [
            { name: "expression", required: true, description: "the expression, e.g. \"(1920/1080) * 100\"" },
        ]
    },
    read_image: {
        schemaOnly: true,
        summary: "Look at an image file and answer a question about it.",
        args: [
            { name: "path", required: true, description: "the image inside the linked folder" },
            { name: "question", required: false, description: "what to look for; omitted means describe it" },
        ]
    },
    read_image_text: {
        schemaOnly: true,
        summary: "Read the text printed inside an image (OCR).",
        args: [
            { name: "path", required: true, description: "the image inside the linked folder" },
        ]
    },
    read_pdf: {
        schemaOnly: true,
        summary: "Read text out of a PDF, by page.",
        args: [
            { name: "path", required: true, description: "the PDF inside the linked folder" },
            { name: "page_start", required: false, description: "first page, 1-based" },
            { name: "page_end", required: false, description: "last page" },
        ]
    },
    extract_pdf: {
        schemaOnly: true,
        summary: "Pull EVERYTHING out of a PDF — full text, a rendered image of every " +
            "page, embedded images/figures, per-page OCR of scanned pages, plus metadata, " +
            "outline, links, annotations, form values and embedded files — into a " +
            "\"<name>.extract/\" folder beside the source. Use for PDFs with images, " +
            "diagrams, tables, forms, or scanned pages.",
        args: [
            { name: "path", required: true, description: "the PDF (in the linked folder or an attachment)" },
            { name: "page_start", required: false, description: "first page, 1-based (paged in 30s for big docs)" },
            { name: "page_end", required: false, description: "last page" },
        ]
    },
    media_probe: {
        schemaOnly: true,
        summary: "Report what an audio or video file actually is.",
        args: [
            { name: "path", required: true, description: "the media file inside the linked folder" },
        ]
    },
    media_transform: {
        schemaOnly: true,
        summary: "Transform audio or video with ffmpeg.",
        args: [
            { name: "op", required: true, description: "fade_in | fade_out | volume | trim | convert | extract_audio | normalize" },
            { name: "input", required: true, description: "source file inside the linked folder" },
            { name: "output", required: true, description: "destination file inside the linked folder" },
            { name: "start_seconds", required: false, description: "fade_out / trim: where it begins (default 0)" },
            { name: "end_seconds", required: false, description: "trim: where it ends (omit to trim to the end)" },
            { name: "fade_seconds", required: false, description: "fade_in / fade_out: the fade length in seconds" },
            { name: "factor", required: false, description: "volume: gain multiplier 0-8 (0.5 halves, 2 doubles)" },
        ]
    },
    ask_reasoner: {
        schemaOnly: true,
        summary: "Hand a hard sub-problem to a stronger reasoning model.",
        args: [
            { name: "question", required: true, description: "the question, stated so it stands alone" },
            { name: "context", required: false, description: "anything the reasoner needs that it cannot see" },
        ]
    },
    ask_fleet: {
        schemaOnly: true,
        summary: "Run up to 8 independent tasks in parallel on this " +
                 "conversation's assigned agent fleet.",
        args: [
            { name: "tasks", required: false, type: "array",
              description: "independent tasks to run concurrently, max 8" },
            { name: "task", required: false, description: "a single task, if only one" },
            { name: "context", required: false,
              description: "shared background every task needs" },
        ]
    },
    ask_cloud_model: {
        schemaOnly: true,
        summary: "Ask a linked cloud endpoint one question.",
        args: [
            { name: "question", required: true, description: "the question, stated so it stands alone" },
        ]
    },
    suggest_model: {
        schemaOnly: true,
        summary: "Ask which model suits a kind of work.",
        args: [
            { name: "task", required: true, description: "what the work is" },
        ]
    },
    find_api: {
        schemaOnly: true,
        summary: "Find a public API for a kind of data.",
        args: [
            { name: "query", required: true, description: "what the data is, e.g. \"molecular weight\"" },
        ]
    },
    find_symbol: {
        schemaOnly: true,
        summary: "Find a schematic symbol by name.",
        args: [
            { name: "query", required: true, description: "the part or symbol, e.g. \"opamp\"" },
        ]
    },
    check_schematic: {
        schemaOnly: true,
        summary: "Check a KiCad schematic for electrical errors.",
        args: [
            { name: "path", required: true, description: "the .kicad_sch file inside the linked folder" },
        ]
    },
    export_schematic: {
        schemaOnly: true,
        summary: "Render a schematic to an image.",
        args: [
            { name: "path", required: true, description: "the .kicad_sch file" },
            { name: "format", required: false, description: "svg or png" },
        ]
    },
    review_config: {
        schemaOnly: true,
        summary: "Review configuration files for unsafe settings.",
        args: [
            { name: "path", required: false, description: "one file; omitted means every config file found" },
        ]
    },
    audit_dependencies: {
        schemaOnly: true,
        summary: "Inventory dependencies and flag unpinned or non-registry installs.",
        args: [
            { name: "path", required: false, description: "one manifest; omitted means every manifest found" },
        ]
    },
    scan_secrets: {
        schemaOnly: true,
        summary: "Scan the linked folder for leaked keys and tokens.",
        args: [
            { name: "path", required: false, description: "one file or folder; omitted means the whole folder" },
        ]
    },
    crypto_auth_review: {
        schemaOnly: true,
        summary: "Review code for weak or home-rolled crypto and auth, and confirm strong password hashing is present.",
        args: [
            { name: "path", required: false, description: "one file or sub-folder; omitted reviews the whole folder" }
        ]
    },
    audit_code: {
        schemaOnly: true,
        summary: "Scan source for common web and backend bug classes (injection, XSS, SSRF, unsafe deserialization).",
        args: [
            { name: "path", required: false, description: "one file or sub-folder; omitted scans the whole folder" }
        ]
    },
    scan_secret_history: {
        schemaOnly: true,
        summary: "Scan git history for secrets that were committed and later removed.",
        args: [
            { name: "path", required: false, description: "limit to one file or sub-folder; omitted scans all history" }
        ]
    },
    port_scan: {
        schemaOnly: true,
        summary: "Check which ports answer on a host you are authorised to test.",
        args: [
            { name: "target", required: true, description: "the host" },
            { name: "ports", required: false, description: "e.g. \"22,80,443\"; omitted means the common ones" },
        ]
    },
    fuzz_target: {
        schemaOnly: true,
        summary: "Probe one parameter of an authorised target for input handling faults.",
        args: [
            { name: "target", required: true, description: "the full URL" },
            { name: "param", required: true, description: "the parameter to vary" },
        ]
    },
    exploit_validate: {
        schemaOnly: true,
        summary: "Confirm one specific weakness on an authorised target.",
        args: [
            { name: "target", required: true, description: "the full URL" },
            { name: "check", required: true, description: "security-headers | server-banner | error-disclosure | directory-listing" },
        ]
    },
    sandbox_test: {
        schemaOnly: true,
        summary: "Run code in a sandbox and assert things about it.",
        args: [
            { name: "files", required: true, description: "an object of filename to file contents" },
            { name: "checks", required: true, description: "a list of {name, language, code} assertions" },
        ]
    },
    stop_server: {
        schemaOnly: true,
        summary: "Stop a server this session started.",
        args: [
            { name: "id", required: true, description: "the server id, e.g. \"serve-8080\"" },
        ]
    },
    write_clipboard: {
        schemaOnly: true,
        summary: "Put text on the system clipboard.",
        args: [
            { name: "text", required: true, description: "what to put there" },
        ]
    },
    board_identify: {
        schemaOnly: true,
        summary: "Read what a connected board actually is, from its own flash and boot log.",
        args: [
            { name: "port", required: true, description: "COM port, e.g. COM10" },
        ]
    },
    backup_firmware: {
        schemaOnly: true,
        summary: "Copy a board's whole flash to a file before overwriting it.",
        args: [
            { name: "port", required: true, description: "COM port to read" },
            { name: "sizeBytes", required: false, type: "number",
              description: "flash size in bytes; defaults to 16MB" },
            { name: "name", required: false, description: "file name for the backup" },
        ]
    },
    serial_read: {
        schemaOnly: true,
        summary: "Listen to one serial port and return what the device says.",
        args: [
            { name: "port", required: true, description: "COM port, e.g. COM10" },
            { name: "baud", required: false, type: "number",
              description: "rate, default 115200; an ESP32 ROM boot log is 74880" },
            { name: "ms", required: false, type: "number",
              description: "how long to listen, default 3000" },
            { name: "reset", required: false, type: "boolean",
              description: "pulse the reset line first — an ESP32 prints its boot " +
                  "log ONLY when it restarts, so a running board is silent without this" },
        ]
    },
    serial_write: {
        schemaOnly: true,
        summary: "Send text to a serial device and read its reply.",
        args: [
            { name: "port", required: true, description: "COM port, e.g. COM10" },
            { name: "data", required: true, description: "what to send" },
            { name: "baud", required: false, type: "number", description: "rate, default 115200" },
            { name: "newline", required: false, type: "boolean", description: "append a line ending (default true)" },
            { name: "read_ms", required: false, type: "number", description: "how long to listen for a reply" },
        ]
    },
    install_toolchain: {
        schemaOnly: true,
        summary: "Install a named board toolchain on this machine.",
        args: [
            { name: "tool", required: true,
              description: "arduino-cli, esp32-core, esptool or platformio — no other value is accepted" },
        ]
    },
    flash_device: {
        schemaOnly: true,
        summary: "Compile a sketch and upload it to a board, as one action.",
        args: [
            // port and sketch are required by the arduino and platformio paths
            // and refused at runtime with the missing piece named — the schema
            // leaves them optional so a uf2 call can omit them entirely
            { name: "port", required: false,
              description: "COM port to upload through (arduino and platformio; uf2 uses none)" },
            { name: "sketch", required: false,
              description: "sketch folder or .ino inside the linked workspace (arduino and platformio)" },
            { name: "fqbn", required: false,
              description: "board id, e.g. esp32:esp32:esp32s3; detected from the port when omitted" },
            { name: "tool", required: false,
              description: "arduino | platformio | uf2 — omit for auto: a .uf2 file means uf2, " +
                  "a platformio.ini at or above the sketch means platformio, else arduino" },
            { name: "file", required: false,
              description: "uf2 only: the .uf2 firmware file inside the linked workspace" },
            { name: "env", required: false,
              description: "platformio only: environment name from platformio.ini" },
            { name: "drive", required: false,
              description: "uf2 only: the mounted bootloader drive, e.g. \"E:\" — auto-detected when exactly one" },
        ]
    },
    inspect_devices: {
        schemaOnly: true,
        summary: "List USB and serial hardware attached to this machine.",
        args: [
            { name: "port", required: false, description: "listen on one port instead of listing" },
            { name: "listen_ms", required: false, description: "how long to listen, in milliseconds" },
        ]
    },
    system_stats: {
        schemaOnly: true,
        summary: "This machine's memory, CPU and disk right now. Takes no arguments.",
        args: [
        ]
    },
    process_list: {
        schemaOnly: true,
        summary: "The heaviest running processes by memory. Takes no arguments.",
        args: [
        ]
    },
    read_clipboard: {
        schemaOnly: true,
        summary: "Read the text currently on the system clipboard. Takes no arguments.",
        args: [
        ]
    },
    list_files: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "List files in the linked folder. Start here to see what exists.",
        args: [
            { name: "path", required: false, description: "sub-folder, or \".\" for the whole folder (default)" },
            // NATIVE CALLERS CANNOT PAGE A TOOL WHOSE SCHEMA HAS NO PAGE
            // ARGUMENT. The text protocol reads the help line; this is the
            // same fact for the models that read the schema instead.
            { name: "offset", required: false, description: "skip this many entries — use the \"nextOffset\" from the previous call to read the rest of a large folder" }
        ]
    },
    read_file: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Read a file from the linked folder.",
        args: [
            { name: "path", required: true, description: "file path relative to the folder, e.g. \"src/index.js\"" },
            { name: "fromLine", required: false, description: "first line to read (1-based)" },
            { name: "lines", required: false, description: "how many lines to read" },
            // NATIVE CALLERS CANNOT PAGE A TOOL WHOSE SCHEMA HAS NO PAGE
            // ARGUMENT (see list_files above). A truncated byte-mode read says
            // "continue with offset N" — this is the argument that makes that
            // sentence actionable instead of a dead end.
            { name: "offset", required: false, description: "byte offset to start from — use it to page past a truncated read instead of re-reading the same first slice" }
        ]
    },
    write_file: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Create or overwrite a file with complete content.",
        args: [
            { name: "path", required: true, description: "file path relative to the folder" },
            { name: "content", required: true, description: "the ENTIRE file body — never a fragment or a diff" }
        ]
    },
    edit_file: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Replace an exact string in a file. The find text must match byte for byte.",
        args: [
            { name: "path", required: true, description: "file path relative to the folder" },
            { name: "find", required: true, description: "exact text to replace, including indentation" },
            { name: "replace", required: true, description: "text to put in its place" }
        ]
    },
    move_file: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Move or rename a file inside the folder.",
        args: [
            { name: "from", required: true, description: "current path" },
            { name: "to", required: true, description: "new path" }
        ]
    },
    make_dir: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Create a directory inside the folder.",
        args: [{ name: "path", required: true, description: "directory path to create" }]
    },
    delete_file: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Delete a file. Staged for the operator's approval before it runs.",
        args: [{ name: "path", required: true, description: "file path to delete" }]
    },
    search_files: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Search the folder's text for a string or pattern.",
        args: [
            { name: "query", required: true, description: "text to look for" },
            { name: "path", required: false, description: "limit the search to this sub-folder" }
        ]
    },
    run_script: {
        // SCHEMA ONLY. The text protocol's help line for these already
        // carries a worked example and is what every existing session's
        // system prompt says; this entry exists so NATIVE calling can
        // advertise real arguments without silently rewriting that prompt.
        schemaOnly: true,
        summary: "Run a script. Staged for the operator's approval before it runs.",
        args: [
            { name: "language", required: true, description: "python | node | bash | powershell" },
            { name: "code", required: true, description: "the complete script source" },
            { name: "workspace", required: false, type: "boolean",
              description: "true when the script reads or writes files in the linked folder — it runs there, stated on the approval card" }
        ]
    },

    build_model: {
        summary: "Build a 3D solid and export it (STEP/STL). Ask for dimensions if none were given.",
        args: [
            { name: "shape", required: true, description: "box | cylinder | cone | sphere | torus" },
            { name: "dimensions", required: true, description: 'millimetres, e.g. {"length":60,"width":40,"height":20} or {"d":50,"h":120}' },
            { name: "format", required: false, description: "step (default) | stl | iges" }
        ]
    },
    draw_schematic: {
        summary: "Generate an electrical schematic from a component and net list.",
        args: [
            { name: "components", required: true, description: 'e.g. [{"ref":"R1","symbol":"Device:R","value":"1k"}]' },
            { name: "nets", required: true, description: 'e.g. [{"name":"OUT","pins":["R1.2","R2.1"]}]' },
            { name: "title", required: false, description: "sheet title for the title block" }
        ]
    },
    capture_drawing: {
        summary: "Read a schematic drawing (image or PDF) with the vision model and " +
            "rebuild it as a real ERC-checked KiCad schematic. The rebuild is a " +
            "draft — report the uncertainties to the user for verification.",
        args: [
            { name: "path", required: true, description: "drawing in the workspace (png/jpg/pdf)" },
            { name: "page", required: false, description: "PDF page number (default 1)" },
            { name: "title", required: false, description: "sheet title (defaults to the file name)" }
        ]
    },
    transcribe_audio: {
        summary: "Transcribe speech in an audio or video file to text, offline. " +
            "Writes a .txt next to the file unless told not to.",
        args: [
            { name: "path", required: true, description: "audio/video file in the workspace (m4a, mp3, wav, mp4…)" },
            { name: "language", required: false, description: 'e.g. "en" — auto-detected if omitted' },
            { name: "save", required: false, description: "false to return the text without writing a file" }
        ]
    },
    draw_diagram: {
        summary: "Render a Graphviz DOT diagram — block diagrams, state machines, " +
            "loop wiring, dependency graphs. You author the DOT text.",
        args: [
            { name: "dot", required: true, description: 'DOT source, e.g. "digraph { PSU -> F1 -> K1 }"' },
            { name: "out", required: false, description: 'output file, e.g. "loop.svg" (default diagram.svg)' },
            { name: "engine", required: false, description: "dot (default) | neato | fdp | circo | twopi" },
            { name: "format", required: false, description: "svg (default) | png | pdf" }
        ]
    },
    query_data: {
        summary: "Run SQL over CSV files or a SQLite database. Read-only: the query " +
            "cannot write, attach files, or reach the machine.",
        args: [
            { name: "sql", required: true, description: 'e.g. "select tag, avg(value) from readings group by tag"' },
            { name: "csv", required: false, description: 'CSV files to load as tables, e.g. ["readings.csv"]' },
            { name: "database", required: false, description: "an existing .db file instead of CSVs" }
        ]
    },
    edit_pdf: {
        summary: "Split, merge, rotate, extract pages from, decrypt or repair a PDF.",
        args: [
            { name: "op", required: true, description: "split | merge | rotate | pages | decrypt | repair | info" },
            { name: "path", required: true, description: "the PDF (not needed for merge)" },
            { name: "out", required: false, description: "output file or folder" },
            { name: "pages", required: false, description: 'page range for pages/rotate, e.g. "1-5" or "1,3,7-9"' },
            { name: "inputs", required: false, description: "for merge: the list of PDFs in order" }
        ]
    },
    edit_image: {
        summary: "Resize, crop, rotate, convert or inspect an image.",
        args: [
            { name: "op", required: true, description: "resize | crop | rotate | convert | grayscale | trim | thumbnail | identify" },
            { name: "path", required: true, description: "the image in the workspace" },
            { name: "size", required: false, description: 'for resize, e.g. "1200x" (width, keep aspect) or "800x600"' },
            { name: "region", required: false, description: 'for crop, e.g. "400x300+10+20"' },
            { name: "out", required: false, description: "output file (defaults beside the source)" }
        ]
    },
    serve_folder: {
        summary: "Serve a workspace folder over HTTP on localhost so the user can " +
            "open what you built in a browser. The user approves each launch.",
        args: [
            { name: "path", required: true, description: 'folder to serve, e.g. "site" — "." for the whole workspace, chosen deliberately' },
            { name: "port", required: false, description: "1024-65535 (default: automatic)" },
            { name: "cors", required: false, description: "true to let served pages call other local APIs" }
        ]
    },
    redline_drawing: {
        summary: "Apply the user's dictated changes to a captured drawing, then " +
            "regenerate and re-check it. Translate their words into edit ops.",
        args: [
            { name: "path", required: true, description: "the drawing image (or its .capture.json)" },
            { name: "edits", required: true, description:
                '[{"op":"set_value","ref":"F2","value":"10A"}, ' +
                '{"op":"connect","pins":["TB1.4","TB1.7"]}, ' +
                '{"op":"add","ref":"K2","type":"relay","value":null}, ' +
                '{"op":"remove","ref":"R9"}, {"op":"disconnect","pin":"K1.A2"}]' }
        ]
    },
    simulate_circuit: {
        summary: "Solve a circuit with SPICE and return real numbers.",
        args: [
            { name: "netlist", required: true, description: "SPICE netlist text" },
            { name: "analysis", required: true, description: 'e.g. {"type":"op"} or {"type":"tran","args":"1u 10m"}' },
            { name: "probes", required: false, description: 'e.g. ["v(out)","i(V1)"]' }
        ]
    },
    generate_image: {
        summary: "Render a PNG from a text description.",
        args: [
            { name: "prompt", required: true, description: "what to draw, described plainly" },
            { name: "path", required: false, description: "where to save it in the workspace" },
            { name: "overwrite", required: false, type: "boolean",
              description: "true to replace an existing file; otherwise a collision saves to name-2.png" },
            // the engine reads and applies these; advertise them tersely so the
            // model can set dimensions without bloating a token-tight prompt
            { name: "width", required: false, type: "number", description: "px (default 512)" },
            { name: "height", required: false, type: "number", description: "px (default 512)" },
            { name: "negative", required: false, description: "what to keep out" },
            { name: "steps", required: false, type: "number", description: "sampling steps (default 4)" },
            { name: "seed", required: false, type: "number", description: "fix for a reproducible image" }
        ]
    },
    research_topic: {
        summary: "Search the web, read the sources, and save them as a folder.",
        args: [
            { name: "topic", required: true, description: "what to research, as a specific question" },
            { name: "max_sources", required: false, description: "how many results to read (default 8)" }
        ]
    },
    git_clone: {
        // schemaOnly: native calling needs the url/dir schema, but the prompt
        // keeps git_clone's own short help line (the 8192-window canary has no
        // spare room for the longer summary here)
        schemaOnly: true,
        summary: "Clone a git repository into the workspace using the machine's own git and credentials.",
        args: [
            { name: "url", required: true, description: "the repository URL, e.g. https://github.com/owner/repo.git" },
            { name: "dir", required: false, description: "optional subfolder name (defaults to the repo name)" }
        ]
    },
    github_sign_in: {
        // genuinely takes none — SAID out loud, so native calling ships a
        // declared empty schema, not an accidental one (see auditManifest)
        summary: "Open the secure GitHub browser sign-in (OAuth). Takes no arguments.",
        args: []
    },
    scaffold_app: {
        schemaOnly: true,
        summary: "Create a Vite+React app in the workspace and install its deps.",
        args: [
            { name: "name", required: true, description: "the app/folder name" },
            { name: "template", required: false, description: "\"react\" (default) or \"react-ts\"" }
        ]
    },
    build_app: {
        schemaOnly: true,
        summary: "Build a scaffolded app to <dir>/dist.",
        args: [{ name: "dir", required: true, description: "the app folder to build" }]
    },
    run_dev_server: {
        schemaOnly: true,
        summary: "Start the live Vite dev server (localhost only), stoppable.",
        args: [
            { name: "dir", required: true, description: "the app folder to run" },
            { name: "port", required: false, description: "a port 1024-65535 (default automatic)" }
        ]
    }
};

/** One help line for a tool, richer when we have structured args for it. */
function helpFor(name, fallbackHelp) {
    const d = ARG_DETAIL[name];
    if (!d || d.schemaOnly) return fallbackHelp;
    const args = d.args.map(a =>
        `${a.name}${a.required ? "" : "?"}: ${a.description}`).join("; ");
    return `${name} — ${d.summary} args: ${args}`;
}

/**
 * Sanity check, run by the tests: every tool we promise a default offer for
 * must actually describe its arguments, or the model is told it can start
 * something it has not been taught to call.
 */
function auditManifest(registeredToolNames = []) {
    const problems = [];
    for (const t of NEEDS_CONSTRAINTS) {
        if (!DEFAULT_OFFERS[t]) problems.push(`${t} is listed as needing constraints but has no default offer`);
    }
    for (const t of Object.keys(ARG_DETAIL)) {
        const d = ARG_DETAIL[t];
        // A TOOL THAT GENUINELY TAKES NONE MAY SAY SO — but only out loud.
        // An absent entry and an empty one used to be the same thing here, and
        // that is precisely the bug this table exists to prevent: thirty tools
        // went over the wire declaring no arguments BY OMISSION, which a
        // schema-constrained model reads as "this tool is useless". Declaring
        // an empty `args` array next to a summary saying "takes no
        // arguments" is a statement; leaving the entry out is an accident.
        if (!d.args) problems.push(`${t} has no argument descriptions`);
        else if (!d.args.length && !/takes no arguments/i.test(d.summary || "")) {
            problems.push(`${t} declares no arguments but does not say so in its summary`);
        }
        // a REQUIRED argument is the point for a tool that needs constraints;
        // list_files legitimately takes none (the whole folder is the default)
        if (NEEDS_CONSTRAINTS.has(t) && !d.args.some(a => a.required)) {
            problems.push(`${t} declares no required argument`);
        }
    }
    // a tool that is registered and needs constraints should have arg detail
    for (const name of registeredToolNames) {
        if (NEEDS_CONSTRAINTS.has(name) && !ARG_DETAIL[name]) {
            problems.push(`${name} is registered and needs constraints but has no argument detail`);
        }
    }
    return { ok: problems.length === 0, problems };
}


/*
 * THE SAME TOOLS, IN THE PROTOCOL THE MODEL WAS TRAINED ON.
 *
 * .lcl has always driven its loop through a TEXT protocol: the tools are
 * described in the system prompt and the model is asked to emit a fenced JSON
 * call. That works for models trained to follow instructions and fails for
 * models trained to REASON — measured on the user's own repository, where
 * deepseek-r1:70b wrote "1. First, I'll list all files:" six times and never
 * emitted a call, then invented the results.
 *
 * Every OpenAI-compatible host takes a `tools` array instead, and 147 of
 * DeepInfra's 360 models declare support for it. This turns the manifest we
 * already keep into that array. Arguments are described, never invented: the
 * descriptions are the same ones the text protocol shows.
 */
function openAiSchemas(names = [], helpByName = {}) {
    const out = [];
    for (const name of names) {
        const d = ARG_DETAIL[name];
        const properties = {};
        const required = [];
        for (const a of (d && d.args) || []) {
            // every argument this codebase takes is a scalar or a small JSON
            // literal the model writes as text; describing them as strings is
            // honest and keeps a schema mismatch from refusing a good call
            properties[a.name] = { type: "string", description: a.description };
            if (a.required) required.push(a.name);
        }
        out.push({
            type: "function",
            function: {
                name,
                // ARG_DETAIL covers the tools with structured arguments; for
                // the rest the registry's own help line is the description, so
                // no tool is ever offered to a model without one
                description: (d && d.summary) || String(helpByName[name] || "").slice(0, 400)
                    || name.replace(/_/g, " "),
                parameters: { type: "object", properties, required }
            }
        });
    }
    return out;
}

module.exports = {
    CLARIFY, DEFAULT_OFFERS, NEEDS_CONSTRAINTS, ARG_DETAIL,
    clarifyPrompt, parseClarify, renderClarify, helpFor, auditManifest,
    openAiSchemas
};
