/**
 * Script execution guard.
 *
 * THE THREAT MODEL, STATED PLAINLY
 * --------------------------------
 * Every other tool in this app is confined to a folder the user picked. A shell
 * script is not. It runs with the user's full privileges, and no path check,
 * scope rule or sandbox in this codebase applies to it. It is the one
 * capability where a mistake is not revertible.
 *
 * So this guard is deliberately NOT a filter that tries to catch bad scripts.
 * That approach loses: shell languages have unlimited ways to express the same
 * action, and a denylist is a promise you cannot keep. Instead the design is:
 *
 *   1. The human reads the script before it runs. ALWAYS. No auto-execute
 *      path exists, not even for scripts that look harmless. This is the
 *      actual control — everything below is defence in depth behind it.
 *   2. A denylist blocks the categories where even a shown-and-approved
 *      script is a bad idea, because the user cannot be expected to spot a
 *      subtly destructive one-liner in a wall of text.
 *   3. No elevation, ever. The agent cannot request admin rights. Anything
 *      needing them is handed to the user to run themselves.
 *   4. A rollback plan is required for mutating scripts, or it does not run.
 *   5. Everything is audited, including what was refused.
 */

const CLASSIFICATION_EXECUTE = "execute";

/**
 * Categories refused outright. Each entry says WHY, because a refusal the user
 * cannot understand is indistinguishable from a bug.
 *
 * These patterns are intentionally broad. False positives are cheap here — the
 * user can run the command themselves — while a false negative is permanent.
 */
const DENY_RULES = [
    {
        id: "disk-format",
        why: "formats or repartitions a disk",
        patterns: [
            /\bformat(-volume)?\b[^\n]*\b[a-z]:/i,
            /\bdiskpart\b/i,
            /\bmkfs(\.\w+)?\b/i,
            /\bnew-partition\b/i,
            /\bclear-disk\b/i,
            /\bInitialize-Disk\b/i,
            /\bdd\s+if=[^\n]*of=\/dev\//i
        ]
    },
    {
        id: "security-disable",
        why: "disables antivirus, the firewall, or OS security controls",
        patterns: [
            /set-mppreference[^\n]*disable/i,
            /\bdisable\w*\s+(defender|antivirus|realtimemonitoring)/i,
            /add-mppreference[^\n]*exclusionpath/i,
            /netsh\s+advfirewall\s+set[^\n]*(off|disable)/i,
            /set-netfirewallprofile[^\n]*-enabled\s+false/i,
            /\bbcdedit\b[^\n]*(testsigning|nointegritychecks)/i,
            /Set-ExecutionPolicy\s+(Unrestricted|Bypass)\s+-Scope\s+LocalMachine/i
        ]
    },
    {
        id: "credential-access",
        why: "reads credentials, keys, or the password store",
        patterns: [
            /\.ssh[\\/](id_[a-z0-9]+|identity)\b/i,
            /\.aws[\\/]credentials\b/i,
            /\bmimikatz\b/i,
            /\b(lsass|ntds\.dit|SAM)\b[^\n]*\b(dump|copy|save|reg\s+save)/i,
            /reg\s+save[^\n]*\bHKLM\\(SAM|SECURITY|SYSTEM)\b/i,
            /Get-Credential[^\n]*\|\s*(Out-File|Export|ConvertTo)/i,
            /\bvaultcmd\b|\bcmdkey\s+\/list/i
        ]
    },
    {
        id: "mass-delete",
        why: "recursively deletes a drive root, home, or system directory",
        patterns: [
            /remove-item[^\n]*-recurse[^\n]*\b[a-z]:\\?\s*['"]?\s*(-force)?\s*$/i,
            /\brd\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i,
            /\brm\s+-rf\s+\/(\s|$)/,
            /\brm\s+-rf\s+~(\s|$)/,
            /remove-item[^\n]*\$env:(USERPROFILE|SystemRoot|windir)\b[^\n]*-recurse/i,
            /\b(del|erase)\s+\/[sq]\b[^\n]*\\Windows\b/i
        ]
    },
    {
        id: "privilege-escalation",
        why: "requests administrator rights",
        patterns: [
            /-verb\s+runas/i,
            /\bsudo\b/,
            /start-process[^\n]*-verb\s*['"]?runas/i,
            /\brunas\s+\/user:/i
        ]
    },
    {
        id: "remote-code",
        why: "downloads and executes code from the network",
        patterns: [
            /(iwr|invoke-webrequest|curl|wget)[^\n]*\|\s*(iex|invoke-expression|bash|sh|powershell)/i,
            /invoke-expression[^\n]*(downloadstring|invoke-restmethod)/i,
            /\biex\s*\(/i,
            /downloadstring\s*\(/i
        ]
    },
    {
        id: "persistence",
        why: "installs itself to run automatically at startup",
        patterns: [
            /new-scheduledtask|schtasks\s+\/create/i,
            // the cmdlet may appear before OR after the key path, so match the
            // Run key alongside any write verb anywhere on the line
            /(new-itemproperty|set-itemproperty|reg\s+add)[^\n]*CurrentVersion\\Run\b/i,
            /CurrentVersion\\Run\b[^\n]*(new-itemproperty|set-itemproperty|reg\s+add)/i,
            /\bRunOnce\b[^\n]*(itemproperty|reg\s+add)/i,
            /new-service\b|sc\s+create\b/i,
            /\bcrontab\s+-/i,
            /\/Library\/LaunchAgents|\/Library\/LaunchDaemons/i
        ]
    },
    {
        id: "account-change",
        why: "creates or modifies user accounts or group membership",
        patterns: [
            // args between the account name and the switch are normal
            // (`net user bob P@ssw0rd /add`), so allow anything in between
            /\bnet\s+(user|localgroup)\b[^\n]*\s\/(add|delete|active)/i,
            /new-localuser|add-localgroupmember|remove-localgroupmember|set-localuser/i,
            /\buseradd\b|\busermod\b|\buserdel\b|\bpasswd\s+\S/i,
            /\bdscl\s+\.\s+-(create|delete|passwd)/i
        ]
    },
    {
        id: "system-wipe",
        why: "resets Windows or deletes restore points and shadow copies",
        patterns: [
            /vssadmin[^\n]*delete\s+shadows/i,
            /wbadmin[^\n]*delete\s+catalog/i,
            /systemreset\b|\bsysprep\b/i,
            /Checkpoint-Computer[^\n]*-Remove|Disable-ComputerRestore/i
        ]
    }
];

/** Commands that mutate state, so a rollback plan is required. */
const MUTATING_HINTS = [
    /\bset-\w+/i, /\bremove-\w+/i, /\bnew-\w+/i, /\bstop-\w+/i, /\bstart-\w+/i,
    /\brestart-\w+/i, /\bmove-item\b/i, /\bcopy-item\b/i, /\brename-item\b/i,
    /\bout-file\b/i, /\bset-content\b/i, /\badd-content\b/i, /\breg\s+(add|delete)\b/i,
    /\bnet\s+stop\b/i, /\bnet\s+start\b/i, /\btaskkill\b/i, /\bstop-process\b/i,
    /\bmkdir\b/i, /\brm\b/i, /\bmv\b/i, /\bcp\b/i, />>?\s*\S/
];

const MAX_SCRIPT_CHARS = 20000;

/**
 * Inspect a script. Returns:
 *   { allowed:false, ruleId, why, evidence }        — refused outright
 *   { allowed:true, mutating, needsRollback, ... }  — may be OFFERED to the user
 *
 * "allowed" never means "run it". It means "safe enough to show the user and
 * ask". Execution still requires explicit human approval.
 */
function inspect(script, { language = "powershell", rollback = null } = {}) {
    const text = String(script || "");

    if (!text.trim()) {
        return { allowed: false, ruleId: "empty", why: "the script is empty", evidence: "" };
    }
    if (text.length > MAX_SCRIPT_CHARS) {
        return {
            allowed: false,
            ruleId: "too-long",
            why: `the script is ${text.length} characters, over the ${MAX_SCRIPT_CHARS} limit — ` +
                 "a script too long to read is a script that cannot be approved meaningfully",
            evidence: ""
        };
    }

    // strip comments so a denied command cannot hide behind a '#'
    const stripped = text
        .split("\n")
        .map(line => line.replace(/(^|\s)#.*$/, "$1"))
        .join("\n");

    for (const rule of DENY_RULES) {
        for (const pattern of rule.patterns) {
            const m = pattern.exec(stripped);
            if (m) {
                return {
                    allowed: false,
                    ruleId: rule.id,
                    why: rule.why,
                    evidence: m[0].trim().slice(0, 160)
                };
            }
        }
    }

    const mutating = MUTATING_HINTS.some(p => p.test(stripped));
    const hasRollback = typeof rollback === "string" && rollback.trim().length > 0;

    if (mutating && !hasRollback) {
        return {
            allowed: false,
            ruleId: "no-rollback",
            why: "this script changes system state but supplied no rollback plan. " +
                 "Provide a `rollback` argument describing how to undo it, or explain " +
                 "in the script why the change is not reversible",
            evidence: ""
        };
    }

    return {
        allowed: true,
        classification: CLASSIFICATION_EXECUTE,
        language,
        mutating,
        needsRollback: mutating,
        hasRollback,
        // ALWAYS. There is no path where a script runs without the user seeing it.
        requiresApproval: true,
        chars: text.length,
        lines: text.split("\n").length
    };
}

module.exports = { inspect, DENY_RULES, MUTATING_HINTS, CLASSIFICATION_EXECUTE, MAX_SCRIPT_CHARS };
