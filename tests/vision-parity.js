/**
 * VISION PARITY — a node is not a third party.
 *
 * The requirement: the node's models should be available to select from and
 * perform the same level of tasks as the local models, API models, or a
 * rented GPU.
 *
 * activeModelSees() asked the LOCAL engine only, so selecting a
 * vision-capable model on the user's own Spark produced "the current model
 * cannot see images — switch to a vision model" — advice that is nonsense
 * when a multimodal model is already driving. Fixed by routing on WHO is
 * driving.
 *
 * The privacy rule this must never break: images are not shipped to a
 * third-party API because the user linked one for chat. A node is hardware
 * they own; DeepInfra is not. That distinction is the whole design, and the
 * checks below are mostly about proving the third-party path stays shut.
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
    if (cond) { pass++; console.log("PASS |", name); }
    else { fail++; console.log("FAIL |", name, detail ? "- " + JSON.stringify(detail).slice(0, 200) : ""); }
}

const SRC = path.join(__dirname, "..", ".lcl.engine", "core", "visionTool.js");
const src = fs.readFileSync(SRC, "utf8");

// ---- lift the two pure helpers; no Electron, no engine ----
const grabConst = (name) => {
    const m = new RegExp(`const ${name} = (/[\\s\\S]*?/[a-z]*);`).exec(src);
    return m ? m[1] : null;
};
const grabFn = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let j = i; j < src.length; j++) {
        if (src[j] === "{") { depth++; started = true; }
        else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
    }
    return null;
};

const reSrc = grabConst("VISION_NAME");
const fnSrc = grabFn("looksVisionCapable");
check("the vision-name test and its helper exist", !!reSrc && !!fnSrc);

if (reSrc && fnSrc) {
    const looks = new Function(`const VISION_NAME = ${reSrc};\n${fnSrc}\nreturn looksVisionCapable;`)();

    for (const id of ["llava:13b", "qwen2.5-vl-7b", "llama3.2-vision:11b", "moondream",
                      "pixtral-12b", "minicpm-v", "gemma-3-27b", "internvl2-8b",
                      "Qwen/Qwen2-VL-72B-Instruct"]) {
        check(`recognised as multimodal: ${id}`, looks(id) === true, id);
    }
    for (const id of ["gpt-oss:120b", "qwen3-4b-instruct-2507", "deepseek-v4",
                      "llama3.3-70b", "mistral-large", "glm-5.2",
                      "qwen2.5-coder-1.5b-instruct"]) {
        check(`NOT offered vision: ${id}`, looks(id) === false, id);
    }
}

// ---- the routing contract, read off the source ----
check("the driver decides who sees — local engine, or the user's own node — " +
      "and it is THIS SESSION's driver, so a conversation running on the node " +
      "is not told 'the current model cannot see images' because the APP " +
      "default happens to be a text-only API",
    /function visionDriver\(sessionSel\)/.test(src) &&
    /if \(localModelSees\(\)\) return "local";/.test(src) &&
    /sessionSel !== undefined[\s\S]{0,40}cloudModels\.selectedFor\("driver"\)/.test(src));

check("a node qualifies ONLY when it is a node AND the model is multimodal",
    /isNodeEndpoint\(sel\) && looksVisionCapable\(sel\.model\)/.test(src));

// THE PRIVACY PROPERTY. There must be no path that sends an image to an
// endpoint that is not a node.
check("a third-party API is never a vision driver",
    !/isNodeEndpoint[\s\S]{0,40}\|\|/.test(src) &&
    /remote && !cloudModels\.isNodeEndpoint\(remote\)/.test(src));
check("and it says so plainly instead of blaming the model",
    /images are not sent to a third-party API/.test(src));

check("the image is sent to the node, never through the generic router",
    /if \(who === "node"\)[\s\S]{0,200}cloudModels\.streamChat\(messages/.test(src) &&
    !/router\.generate\(messages/.test(src));
check("the local path still goes to the resident engine",
    /const res = await engine\.generate\(messages, 512/.test(src));
check("the result records which hardware answered",
    /via: "node"/.test(src) && /via: "local"/.test(src));

// ---- the tool must still be gated on the same predicate the agent uses ----
const agentSrc = fs.readFileSync(
    path.join(__dirname, "..", ".lcl.engine", "core", "agent.js"), "utf8");
check("agent offers read_image on activeModelSees(), which now includes nodes",
    /if \(all \|\| visionTool\.activeModelSees\(\)\) tools\.read_image/.test(agentSrc));
check("activeModelSees is derived from visionDriver, so the gate and the call " +
      "can never disagree",
    /function activeModelSees\(sessionSel\) \{\s*return !!visionDriver\(sessionSel\);/.test(src));

// ---- cloudModels must be required lazily: visionTool is loaded by the tool
//      manifest in contexts with no Electron ----
check("cloudModels is required at call time, not at module load",
    /let _cloud = null;/.test(src) && /require\("\.\/cloudModels"\)/.test(src) &&
    !/^const cloudModels = require/m.test(src));

console.log(`\n${pass}/${pass + fail} vision-parity checks passed`);
process.exit(fail ? 1 : 0);
