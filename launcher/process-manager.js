const { spawn, spawnSync } = require("child_process");

class ProcessManager {
    constructor(label, command, args, options = {}) {
        this.label = label;
        this.command = command;
        this.args = args;
        this.options = options;
        this.proc = null;
        this.exited = false;
        this.stopping = false;
        this.restartTimer = null;
        this.startedAt = 0;
        this.restartDelay = 2000; // 2 seconds
        this.maxRestarts = 10;
        this.restartCount = 0;
        this.stableUptimeMs = 30000; // a run this long resets the crash budget
    }

    start() {
        console.log(`[LCL] Starting ${this.label}...`);

        this.exited = false;
        this.startedAt = Date.now();

        this.proc = spawn(this.command, this.args, {
            cwd: this.options.cwd || process.cwd(),
            shell: true,
            env: process.env
        });

        this.proc.stdout.on("data", data => {
            console.log(`[${this.label}] ${data}`);
        });

        this.proc.stderr.on("data", data => {
            console.error(`[${this.label} ERROR] ${data}`);
        });

        this.proc.on("close", code => {
            this.exited = true;
            console.log(`[${this.label}] exited with code ${code}`);

            if (Date.now() - this.startedAt >= this.stableUptimeMs) {
                this.restartCount = 0;
            }

            if (this.options.autoRestart && !this.stopping) {
                this.handleRestart();
            }
        });

        return this.proc;
    }

    handleRestart() {
        if (this.restartCount >= this.maxRestarts) {
            console.error(`[${this.label}] reached max restart limit (${this.maxRestarts}). Not restarting.`);
            return;
        }

        this.restartCount++;
        console.log(`[${this.label}] Restarting in ${this.restartDelay}ms... (${this.restartCount}/${this.maxRestarts})`);

        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.stopping) {
                this.start();
            }
        }, this.restartDelay);
    }

    stop() {
        this.stopping = true;

        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }

        // Only kill a live child — a dead child's PID may have been
        // recycled by Windows and belong to an unrelated process.
        if (this.proc && this.proc.pid && !this.exited) {
            console.log(`[LCL] Stopping ${this.label}...`);

            if (process.platform === "win32") {
                // shell:true wraps the child in cmd.exe — kill the whole tree
                // or the real process (engine/backend) is orphaned.
                spawnSync("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"]);
            } else {
                this.proc.kill();
            }
        }
    }
}

module.exports = {
    ProcessManager
};
