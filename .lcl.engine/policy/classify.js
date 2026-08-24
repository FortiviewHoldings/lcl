/**
 * Tool classification table.
 *
 * This is the security-relevant half of a tool's definition, and it is kept
 * separate from the tool's implementation on purpose: adding a tool does not
 * grant it anything. A tool absent from this table is denied by the kernel,
 * so the failure mode of forgetting to classify something is "it does not
 * work", never "it runs unchecked".
 */

/**
 * What the kernel may decide. Defined HERE rather than in kernel.js because a
 * tool spec below names one as its default, and classify.js is the leaf of this
 * pair — kernel.js requires it, so the reverse would be a cycle. kernel.js
 * re-exports DECISION, so nothing that imports it from there had to change.
 *
 *   allow    — run it, record it
 *   notify   — run it, record it, tell the user after the fact
 *   confirm  — do not run; hand back to the UI for explicit approval
 *   deny     — refuse, record the attempt
 */
const DECISION = {
    ALLOW: "allow",
    NOTIFY: "notify",
    CONFIRM: "confirm",
    DENY: "deny"
};

const CLASSIFICATION = {
    READ: "read",              // observes only
    MUTATE: "mutate",          // changes state inside a granted scope
    DESTRUCTIVE: "destructive",// irreversible or wide blast radius
    OFFENSIVE: "offensive",    // acts against a target; engagement-gated
    // Its own tier, above destructive: a shell script is the only capability
    // no path scope constrains. It ALWAYS goes to the human, and the runner is
    // split so the agent can never hold anything executable.
    EXECUTE: "execute",
    // Leaving the machine. A fetch driven by a prompt-injectable small model is
    // an exfiltration channel, so egress DEFAULTS to confirm — the destination
    // is on the card before anything leaves. It is not welded, though: the
    // kernel floor for EGRESS is ALLOW ("your machine, your dial", kernel.js
    // floorFor), so the operator may lower it (and cloudAutoApprove relaxes
    // ask_cloud_model to notify by design). What a dial can NEVER unlock is the
    // secret guard: credentials are refused egress regardless of this setting,
    // so lowering the confirm does not open a silent-exfiltration path for the
    // one thing that matters. Confirm is the default, not an unbreakable wall.
    EGRESS: "egress",
    UNKNOWN: "unknown"
};

/**
 * capability      the grant a session must hold for this tool to exist at all
 * classification  drives allow / notify / confirm / deny
 * defaultDecision optional: overrides the classification's default for THIS tool.
 *                 Always clamped by floorFor(classification), so it can only
 *                 ever be used to state a considered default within what the
 *                 classification already permits — never to escape a floor.
 * limitPerTurn    blast-radius cap; a runaway loop hits this, not the disk
 * scoped          true when the grant carries a path/target the call must stay inside
 */
const TOOL_CLASS = {
    // ---- filesystem, scoped to the linked workspace ----
    list_files:   { capability: "fs.read",  classification: CLASSIFICATION.READ,   scoped: true, limitPerTurn: 20 },
    read_file:    { capability: "fs.read",  classification: CLASSIFICATION.READ,   scoped: true, limitPerTurn: 40 },
    search_files: { capability: "fs.read",  classification: CLASSIFICATION.READ,   scoped: true, limitPerTurn: 20 },
    // reads workspace content by meaning; costs an embed pass, hence the
    // tighter per-turn cap than plain text search
    semantic_search: { capability: "fs.read", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 8 },
    // reads the user's designated knowledge libraries (granted by picking the
    // folder), NOT the workspace — so it is unscoped and base-granted, and
    // works with no folder linked. Containment to library roots is enforced
    // in knowledge.js.
    knowledge_search: { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 12 },
    // READS HARDWARE ON THE END OF A CABLE. Unscoped, because a board is
    // not in the workspace — it is on the machine. READ class and it means
    // it: deviceScan.js has no write, no flash, no reset and no handshake
    // line it can assert, so there is no path from this tool to a changed
    // device. Anything that alters a board is a separate capability and is
    // deliberately not implemented here.
    inspect_devices: { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 6 },
    // reads pixels the same way read_file reads text; each call costs a
    // vision-encoder pass on the resident model
    read_image:      { capability: "fs.read", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 6 },
    // reads a PDF in the workspace; same scope and class as read_file
    read_pdf:        { capability: "fs.read", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 15 },
    // pulls EVERYTHING out of a PDF into a sidecar folder beside the source — a
    // read (of the PDF) that, like read_pdf's .ocr.txt, writes its derived output
    // in scope. Renders + OCRs, so it is heavier: a tighter per-turn limit.
    extract_pdf:     { capability: "fs.read", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 8 },
    // OCR on a workspace image: reads pixels as text, no model involved.
    // ~2s of CPU per page, hence a tighter per-turn limit than read_file.
    read_image_text: { capability: "fs.read", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 10 },

    // ---- workspace-free utilities: no filesystem, no engine ----
    calculate:     { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 30 },
    // suggest_model reads the shipped catalog and what is already linked — no
    // filesystem, no network, no spend. It only advises which model suits a task.
    suggest_model: { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 20 },
    // reading the clipboard is base-granted; WRITING it leaves the sandbox and
    // is therefore NOTIFY, recorded like any state change the user should see
    read_clipboard:  { capability: "sys.read",  classification: CLASSIFICATION.READ,   limitPerTurn: 10 },
    write_clipboard: { capability: "sys.write", classification: CLASSIFICATION.MUTATE, limitPerTurn: 10 },
    write_file:   { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 10 },
    // higher cap than write_file: a multi-spot change is several small edits,
    // and each is far less blast radius than one whole-file rewrite
    edit_file:    { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 15 },
    move_file:    { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 10 },
    make_dir:     { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 10 },
    delete_file:  { capability: "fs.write", classification: CLASSIFICATION.DESTRUCTIVE, scoped: true, limitPerTurn: 5 },

    // ---- machine observation. read-only by design; there is deliberately no
    //      process-kill tool, because "no rogue system" is a hard requirement ----
    system_stats:  { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 10 },
    process_list:  { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 5 },

    // ---- shell scripts. Proposing one is all the model can do; running it
    //      requires a separate human action referencing the proposal id ----
    // Builds a 3D solid in FreeCAD (child process, structured args only — the
    // model never writes Python) and saves ONE file into the workspace.
    build_model: { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },

    // Schematic tools. Drawing writes ONE file into the workspace (mutate,
    // like write_file); ERC and symbol search only read; export writes the
    // rendered artefact next to the source.
    draw_schematic:   { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },
    check_schematic:  { capability: "fs.read",  classification: CLASSIFICATION.READ,   scoped: true, limitPerTurn: 10 },
    export_schematic: { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 8 },
    find_symbol:      { capability: "sys.read", classification: CLASSIFICATION.READ,   limitPerTurn: 15 },

    // The paper-to-KiCad loop. Capture reads a drawing image with the vision
    // model and writes capture.json + the rebuilt .kicad_sch + an SVG (mutate,
    // multiple files, one drawing). Redline edits the capture and regenerates
    // the same set — the .kicad_sch is always REBUILT from the capture, never
    // patched, so ERC always judges the whole sheet.
    capture_drawing:  { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 3 },
    redline_drawing:  { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },

    // Solving a circuit runs ngspice in a child process on a netlist the tool
    // itself vets (.control/.shell refused). Reads nothing, writes only temp.
    simulate_circuit: { capability: "sys.read", classification: CLASSIFICATION.READ,
                        limitPerTurn: 10 },

    // The engine's own static file server: no model code runs, but it opens
    // a localhost port and exposes folder contents over HTTP - a human
    // approves each launch. Stopping one is always safe.
    // Searching the built-in catalog of free APIs reads nothing and calls
    // nothing - it hands back a URL that http_fetch must still be allowed to
    // fetch under the network switch and the public-host guard.
    // Transcription reads an audio file and writes a .txt beside it: a
    // workspace mutation like any other write, no network, no model code.
    // Bundled third-party instruments, driven by argv this engine composes -
    // the model never supplies a command line. Each writes one artefact into
    // the workspace; query_data only reads (read-only + safe mode).
    edit_pdf:     { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },
    edit_image:   { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 8 },
    draw_diagram: { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },
    query_data:   { capability: "fs.read",  classification: CLASSIFICATION.READ,   scoped: true, limitPerTurn: 10 },

    transcribe_audio: { capability: "fs.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },

    find_api:     { capability: "sys.read", classification: CLASSIFICATION.READ, limitPerTurn: 10 },

    // sessionFloor "notify": serve_folder is ENGINE code serving files (it never
    // runs what the model wrote), so "Allow for this conversation" / "Always
    // allow" must actually STICK — without a floor below EXECUTE's confirm, the
    // grant was silently clamped back to confirm and it re-asked every serve,
    // even in a session that had already allowed it. Same fix, same reason, as
    // the device tools above.
    serve_folder: { capability: "sys.execute", classification: CLASSIFICATION.EXECUTE, scoped: true, limitPerTurn: 2, sessionFloor: "notify" },
    stop_server:  { capability: "sys.read",    classification: CLASSIFICATION.READ,    limitPerTurn: 5 },

    // Runs code the model wrote — but in a disposable folder with a scrubbed
    // environment, never the user's files. EXECUTE class because it is still
    // execution and the audit trail should say so, but it is the SAFE way to
    // let a model check its own work: the alternative is proposing a script
    // that touches the real machine, or shipping code nobody ran.
    sandbox_test: { capability: "sys.execute", classification: CLASSIFICATION.EXECUTE,
                    limitPerTurn: 6 },

    run_script: {
        capability: "sys.execute",
        classification: CLASSIFICATION.EXECUTE,
        limitPerTurn: 3
    },

    /* ---- hardware: writing to a board is not reading one ----
     *
     * The product needs to do more than scan a port and read it.
     *
     * EXECUTE, which this kernel welds to confirm, for the same reason
     * run_script is: no path scope constrains a board. A COM port is not
     * inside the workspace, cannot be sandboxed, and the thing on the other
     * end is physical. So every one of these goes to the human with the exact
     * command visible, and the model never holds anything executable.
     *
     * The alternative a model proposed during this build was ONE unscoped
     * shell tool with write permissions. That is a single blind approval on a
     * script nobody reads; these are three approvals a person can actually
     * weigh — talk to it, install its toolchain, flash it. */
    /* sessionFloor: how low a PER-CONVERSATION grant may take this tool. EXECUTE
       welds to confirm by default (a shell script always shows the human), but a
       SCOPED device tool the operator explicitly trusted for this conversation is
       not arbitrary shell — it targets a named port with an allowlisted toolchain.
       "notify" lets a grant loosen it to run-and-show-progress, no gate. run_script
       has no sessionFloor and stays welded. Measured: without this, "Allow for this
       conversation" on flash_device was REJECTED by the confirm floor and silently
       swallowed, so it re-asked every single flash. */
    serial_read:       { capability: "device.write", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 12, sessionFloor: "notify" },
    // reading a board over esptool RESETS it to enter the ROM loader — a real
    // side effect, same as serial_read's reset pulse — so EXECUTE, not READ
    board_identify:    { capability: "device.write", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 6, sessionFloor: "notify" },
    backup_firmware:   { capability: "device.write", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 2, sessionFloor: "notify" },
    serial_write:      { capability: "device.write", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 12, sessionFloor: "notify" },
    install_toolchain: { capability: "device.write", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 3, sessionFloor: "notify" },
    flash_device:      { capability: "device.write", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 4, sessionFloor: "notify" },

    /* ---- GitHub / version control ----
     *
     * The GitHub login is meant to happen in chat, securely. Both run the
     * machine's own git / credential-manager in the real user session, so they
     * are EXECUTE (welded to confirm, exact action shown) like run_script and the
     * device tools: a human sees "sign in to GitHub" or the precise clone url and
     * approves it. github_sign_in opens the browser OAuth — .lcl never sees the
     * token; git_clone writes into the linked workspace. No push here by design. */
    github_sign_in: { capability: "vcs.git", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 2, sessionFloor: "notify" },
    git_clone:      { capability: "vcs.git", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 3, sessionFloor: "notify" },

    /* ---- web scaffold: build a React app in the workspace and serve it ----
     * EXECUTE (npm runs on the real machine, shown to the human) with a notify
     * sessionFloor so "Allow for this conversation" / "Always allow" stick. Uses
     * sys.execute, already base-granted. No deploy tool here — BUILD, NEVER PUSH. */
    scaffold_app:   { capability: "sys.execute", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 2, sessionFloor: "notify" },
    build_app:      { capability: "sys.execute", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 4, sessionFloor: "notify" },
    run_dev_server: { capability: "sys.execute", classification: CLASSIFICATION.EXECUTE, limitPerTurn: 2, sessionFloor: "notify" },

    // ---- defensive security: safe to grant by default on a linked repo ----
    audit_dependencies: { capability: "sec.defensive", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 5 },
    scan_secrets:       { capability: "sec.defensive", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 5 },
    review_config:      { capability: "sec.defensive", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 5 },
    crypto_auth_review: { capability: "sec.defensive", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 5 },
    audit_code:         { capability: "sec.defensive", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 5 },
    scan_secret_history:{ capability: "sec.defensive", classification: CLASSIFICATION.READ, scoped: true, limitPerTurn: 5 },

    // ---- offensive security: never available without a live engagement that
    //      names a target and an expiry. Authorised testing is legitimate; the
    //      gate is what makes it authorised rather than rogue ----
    port_scan:        { capability: "sec.offensive", classification: CLASSIFICATION.OFFENSIVE, scoped: true, limitPerTurn: 3 },
    fuzz_target:      { capability: "sec.offensive", classification: CLASSIFICATION.OFFENSIVE, scoped: true, limitPerTurn: 3 },
    exploit_validate: { capability: "sec.offensive", classification: CLASSIFICATION.OFFENSIVE, scoped: true, limitPerTurn: 1 },

    // ---- network egress. Off by default (net.read granted only when the user
    //      enables networking), and EGRESS-classified so each fetch DEFAULTS to
    //      human-confirmed with the destination shown. The operator can lower
    //      that (their dial — see the EGRESS note above); what holds regardless
    //      is the secret guard, which refuses to let a credential leave whatever
    //      the confirm setting is — THAT is what stops a prompt-injected model
    //      exfiltrating the thing that matters ----
    http_fetch: { capability: "net.read", classification: CLASSIFICATION.EGRESS, limitPerTurn: 5 },
    // Searching sends the query to a third party, which is egress in the sense
    // that matters: something left this machine. It stays EGRESS-classified, and
    // the query is still run through the secret guard before the socket opens.
    //
    // But its DEFAULT is notify, not confirm, and that is a deliberate product
    // decision rather than an oversight:
    //
    //   - Turning networking on is already an explicit, confirmed act. Asking
    //     again for every single search means the headline feature of this
    //     product interrupts itself on every use. Observed: the user turned
    //     networking on, asked for a search, and got nothing — a second gate on
    //     an already-granted capability reads as "broken", not as "secure".
    //   - What leaves is a SEARCH QUERY: no file bodies, no tool output, no
    //     retrieved passages. It is the smallest egress this app can perform,
    //     and the one whose destination (one search engine) is fixed rather
    //     than model-chosen.
    //   - notify is not silent. The call, the query and the result count are
    //     reported to the UI and written to the audit log, so it is visible
    //     after the fact rather than blocking before it.
    //
    // Everything that carries CONTENT off the machine — http_fetch (a
    // model-chosen URL), research_topic (search plus many fetches plus writes),
    // ask_cloud_model and ask_reasoner (the whole turn's context) — keeps the
    // confirm default. The user can move any of these with the permission dials.
    web_search: {
        capability: "net.read",
        classification: CLASSIFICATION.EGRESS,
        defaultDecision: DECISION.NOTIFY,
        limitPerTurn: 5
    },
    // research_topic is a search plus many fetches plus writes to app data. It
    // is the heaviest network action available, so it is confirm-class and
    // rate-limited hard.
    research_topic: { capability: "net.read", classification: CLASSIFICATION.EGRESS, limitPerTurn: 2 },
    // Asking a CLOUD MODEL is the largest egress this app can perform: the
    // prompt carries whatever the turn has gathered — file bodies, tool output,
    // retrieved passages — to a third party's servers. It is therefore the same
    // confirm-class gate as any other fetch, never a quiet fallback when a local
    // model will not fit, and rate-limited so a loop cannot bill the user.
    // cloudModels.js additionally runs the whole request body through the secret
    // guard before the socket opens; the kernel gate is the human half of that.
    ask_cloud_model: { capability: "net.read", classification: CLASSIFICATION.EGRESS, limitPerTurn: 3 },
    // Escalating to the reasoning model. Same egress class — the question leaves
    // the machine — but a tighter per-turn cap, because reasoning output costs
    // several times what the driver's does and a loop that escalates repeatedly
    // is the expensive failure mode.
    ask_reasoner: { capability: "net.read", classification: CLASSIFICATION.EGRESS, limitPerTurn: 2 },
    // the fleet: same egress lane — free-vs-paid is enforced in the handler,
    // and one call already fans out to 8 streams, so 4 calls is 32 agents
    ask_fleet: { capability: "net.read", classification: CLASSIFICATION.EGRESS, limitPerTurn: 4 },

    // ---- media / document tools (the audio-fade class of work) ----
    media_probe:     { capability: "media.read",  classification: CLASSIFICATION.READ,   scoped: true, limitPerTurn: 10 },
    media_transform: { capability: "media.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 5 },

    // ---- image generation. MUTATE, not EXECUTE: it runs a fixed local binary
    //      with clamped, spawn()-array args (no shell, prompt cannot become a
    //      flag) and writes one PNG inside the workspace. Same trust level as
    //      write_file, same notify card, same revert path. Low per-turn cap
    //      because each call is ~25s of the whole machine's compute ----
    generate_image: { capability: "media.write", classification: CLASSIFICATION.MUTATE, scoped: true, limitPerTurn: 3 }
};

/** Capabilities a session gets when the user links a folder. Nothing else. */
const WORKSPACE_GRANTS = ["fs.read", "fs.write", "sec.defensive", "media.read", "media.write"];

/**
 * Granted to every session, because the capability itself is harmless: it only
 * lets the model PROPOSE a script. Running one is a separate human action, so
 * the grant conveys no execution power on its own.
 */
// sys.write covers only the clipboard for now — a user-visible, non-destructive
// surface the user can inspect and clear. It carries no filesystem power.
// device.write joins them on the same argument: the capability only permits
// PROPOSING a write to a board. EXECUTE sends every one to the human, so the
// grant conveys no power on its own — and a board is not workspace-scoped, so
// there is no folder that could mint it instead.
//
// vcs.git joins on the IDENTICAL argument, and its absence here was the whole
// bug: github_sign_in / git_clone are EXECUTE (every one shown to the human for
// approval), and GitHub auth is machine-wide, not workspace-scoped — so a
// session that had no folder-minted grant HARD-DENIED them ("capability
// 'vcs.git' is not granted for this session"), and the model fell back to
// asking for a password. Base-granting the capability lets the approval card
// fire; the human still approves each sign-in and each clone.
const BASE_GRANTS = ["sys.read", "sys.write", "sys.execute", "device.write", "vcs.git"];

module.exports = { CLASSIFICATION, DECISION, TOOL_CLASS, WORKSPACE_GRANTS, BASE_GRANTS };
