const { execFile } = require("child_process");

/**
 * Memory advisor.
 *
 * Looks at what is actually running and startup-configured, then proposes
 * REVERSIBLE changes. It never acts: it produces findings and a script, and the
 * script goes through the normal approval card like any other. That keeps one
 * path for "software changes this machine", with one place to review it.
 *
 * The safety rule that matters here is the keep-list. Anything security,
 * driver, or platform related is never suggested, regardless of how much memory
 * it is using — freeing RAM by disabling Defender is not an optimisation.
 */

/** Never suggest touching these, no matter what they cost. */
const NEVER_TOUCH = [
    // security
    /defender|msmpeng|mdcore|windefend|antivirus|securityhealth|\bsense\b/i,
    // display / GPU
    /graphics|display|nvidia|amdkmd|igfx|intel.*(graphics|arc)/i,
    // audio
    /audio|realtek|rtkaud|focusrite/i,
    // input devices
    /logioptions|logitech/i,
    // core Windows
    /^(csrss|wininit|winlogon|services|lsass|smss|dwm|explorer|svchost|system|registry|fontdrvhost|sihost|ctfmon|taskhostw|runtimebroker|shellhost|dllhost|conhost|spoolsv|audiodg)$/i,
    /memory compression|secure system/i,
    // ourselves — the engine process is named .lcl.engine(.exe)
    /electron|^\.lcl(\.engine)?$|llama-server|node|powershell/i
];

/** Known background apps that are safe to close and easy to relaunch. */
const RECLAIMABLE = [
    { match: /^msedgewebview2$/i, label: "Edge WebView2 hosts",
      why: "background web views for Teams, Widgets and Search — they respawn on demand" },
    { match: /^widgets$|^widgetservice$/i, label: "Windows Widgets",
      why: "the widgets panel; nothing depends on it" },
    { match: /^onedrive/i, label: "OneDrive",
      why: "file sync pauses until you relaunch it" },
    { match: /^ms-teams$|^teams$/i, label: "Microsoft Teams",
      why: "closes the client; you will not receive messages until reopened" },
    { match: /^msedge$/i, label: "Microsoft Edge",
      why: "closes browser windows; Edge restores tabs on next launch" },
    { match: /^powerautomate|^pad\./i, label: "Power Automate",
      why: "desktop flow tooling; only needed while authoring or running flows" },
    { match: /^filmora|^wondershare/i, label: "Wondershare / Filmora",
      why: "tray and notification helpers" },
    { match: /^musehub$/i, label: "MuseHub", why: "app launcher" },
    { match: /^adobe|^acrobat/i, label: "Adobe helpers",
      why: "updater and notification helpers, not Acrobat itself" },
    { match: /^snippingtool$/i, label: "Snipping Tool", why: "left open" },
    { match: /^searchhost$|^startmenuexperiencehost$/i, label: null }   // present but never suggested
];

function protectedName(name) {
    return NEVER_TOUCH.some(re => re.test(name));
}

function classify(name) {
    if (protectedName(name)) return null;
    const hit = RECLAIMABLE.find(r => r.match.test(name));
    return hit && hit.label ? hit : null;
}

/** Group running processes and rank what could be reclaimed. */
function analyse() {
    return new Promise((resolve) => {
        const script =
            "Get-Process | Group-Object ProcessName | ForEach-Object { " +
            "[pscustomobject]@{ name=$_.Name; count=$_.Count; " +
            "ws=(($_.Group|Measure-Object WorkingSet64 -Sum).Sum); " +
            "commit=(($_.Group|Measure-Object PrivateMemorySize64 -Sum).Sum) } } | " +
            "Sort-Object commit -Descending | Select-Object -First 40 | ConvertTo-Json -Compress";

        execFile("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout) => {
                if (err) return resolve({ error: String(err.message || err) });

                let rows = [];
                try {
                    const parsed = JSON.parse(stdout);
                    rows = Array.isArray(parsed) ? parsed : [parsed];
                } catch {
                    return resolve({ error: "could not read the process list" });
                }

                const findings = [];
                let reclaimable = 0;
                for (const r of rows) {
                    if (!r || !r.name) continue;
                    const hit = classify(r.name);
                    if (!hit) continue;
                    if ((r.commit || 0) < 60e6) continue;      // not worth mentioning

                    reclaimable += r.commit || 0;
                    findings.push({
                        process: r.name,
                        label: hit.label,
                        why: hit.why,
                        count: r.count,
                        commitBytes: r.commit || 0,
                        workingBytes: r.ws || 0
                    });
                }

                findings.sort((a, b) => b.commitBytes - a.commitBytes);
                resolve({
                    findings,
                    reclaimableBytes: reclaimable,
                    scanned: rows.length,
                    protectedNote:
                        "Security, display, audio, input and core Windows processes were " +
                        "excluded from consideration."
                });
            });
    });
}

/**
 * Build a script that closes the chosen apps. Reversible by definition — every
 * one of these is relaunchable from the Start menu — and the rollback says so
 * explicitly rather than pretending a restart command exists.
 */
function buildScript(selected) {
    const names = (selected || []).filter(n => typeof n === "string" && !protectedName(n));
    if (!names.length) return null;

    const list = names.map(n => `'${n.replace(/'/g, "''")}'`).join(", ");
    const script = [
        "# Close background applications to free memory.",
        "# Only user-space apps: nothing security, driver or OS related.",
        `$targets = @(${list})`,
        "$before = (Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue",
        "foreach ($n in $targets) {",
        "    $procs = Get-Process -Name $n -ErrorAction SilentlyContinue",
        "    if (-not $procs) { continue }",
        "    $mb = [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum)/1MB)",
        "    $procs | Stop-Process -Force -ErrorAction SilentlyContinue",
        "    Write-Output ('closed {0,-24} {1,6} MB' -f $n, $mb)",
        "}",
        "Start-Sleep -Seconds 3",
        "$after = (Get-Counter '\\Memory\\Available MBytes').CounterSamples[0].CookedValue",
        "Write-Output ('available before : {0:N2} GB' -f ($before/1024))",
        "Write-Output ('available after  : {0:N2} GB' -f ($after/1024))",
        "Write-Output ('recovered        : {0:N2} GB' -f (($after-$before)/1024))"
    ].join("\n");

    const rollback =
        "No system settings are changed, so there is nothing to restore: each of these " +
        "is an ordinary application and reopens normally from the Start menu or its " +
        "usual shortcut. OneDrive resumes syncing when relaunched.";

    return { script, rollback, language: "powershell" };
}

module.exports = { analyse, buildScript, protectedName };
