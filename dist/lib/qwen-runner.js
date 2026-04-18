import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { log } from "./logger.js";
import { buildShellCommand, getShellLaunch, resolveExecutable } from "./shell.js";
function ts() {
    return `[${new Date().toISOString()}] [qwen-runner]`;
}
/**
 * Minimal VT100 terminal screen emulator.
 * Handles cursor positioning, erase-to-EOL, and clear-screen so we always
 * operate on what is actually *visible* on screen rather than the raw byte stream.
 */
class ScreenBuffer {
    rows;
    curRow = 0;
    curCol = 0;
    width;
    height;
    constructor(width = 220, height = 50) {
        this.width = width;
        this.height = height;
        this.rows = Array.from({ length: height }, () => "");
    }
    write(raw) {
        let i = 0;
        while (i < raw.length) {
            const ch = raw[i];
            if (ch === "\x1b") {
                const rest = raw.slice(i + 1);
                // OSC: ESC ] ... BEL or ST
                const oscM = rest.match(/^][^\x07]*(?:\x07|\x1b\\)/);
                if (oscM) {
                    i += 1 + oscM[0].length;
                    continue;
                }
                // CSI: ESC [ params cmd
                const csiM = rest.match(/^\[([0-9;?]*)([A-Za-z@`])/);
                if (csiM) {
                    i += 1 + csiM[0].length;
                    const params = csiM[1];
                    const cmd = csiM[2];
                    const nums = params.split(";").map((n) => (n === "" ? 0 : parseInt(n, 10)));
                    const p0 = nums[0] ?? 0;
                    const p1 = nums[1] ?? 0;
                    if (cmd === "H" || cmd === "f") {
                        this.curRow = Math.min(Math.max((p0 || 1) - 1, 0), this.height - 1);
                        this.curCol = Math.min(Math.max((p1 || 1) - 1, 0), this.width - 1);
                    }
                    else if (cmd === "A") {
                        this.curRow = Math.max(this.curRow - (p0 || 1), 0);
                    }
                    else if (cmd === "B") {
                        this.curRow = Math.min(this.curRow + (p0 || 1), this.height - 1);
                    }
                    else if (cmd === "C") {
                        this.curCol = Math.min(this.curCol + (p0 || 1), this.width - 1);
                    }
                    else if (cmd === "D") {
                        this.curCol = Math.max(this.curCol - (p0 || 1), 0);
                    }
                    else if (cmd === "G") {
                        this.curCol = Math.min(Math.max((p0 || 1) - 1, 0), this.width - 1);
                    }
                    else if (cmd === "K") {
                        // Erase line: 0=to end, 1=to start, 2=whole line
                        const row = this.rows[this.curRow] ?? "";
                        if (p0 === 2) {
                            this.rows[this.curRow] = "";
                        }
                        else if (p0 === 1) {
                            this.rows[this.curRow] = " ".repeat(this.curCol) + row.slice(this.curCol);
                        }
                        else {
                            this.rows[this.curRow] = row.slice(0, this.curCol);
                        }
                    }
                    else if (cmd === "J") {
                        if (p0 === 2 || p0 === 3) {
                            this.rows = Array.from({ length: this.height }, () => "");
                            this.curRow = 0;
                            this.curCol = 0;
                        }
                        else if (p0 === 0) {
                            this.rows[this.curRow] = (this.rows[this.curRow] ?? "").slice(0, this.curCol);
                            for (let r = this.curRow + 1; r < this.height; r++)
                                this.rows[r] = "";
                        }
                    }
                    // Ignore: m (colors), h, l, s, u, etc.
                    continue;
                }
                // ESC c — full reset
                if (rest[0] === "c") {
                    this.rows = Array.from({ length: this.height }, () => "");
                    this.curRow = 0;
                    this.curCol = 0;
                    i += 2;
                    continue;
                }
                // Other two-char ESC sequences — skip
                i += rest.length > 0 ? 2 : 1;
                continue;
            }
            if (ch === "\r") {
                this.curCol = 0;
                i += 1;
                continue;
            }
            if (ch === "\n") {
                this.curRow = Math.min(this.curRow + 1, this.height - 1);
                i += 1;
                continue;
            }
            if (ch === "\x08") { // backspace
                if (this.curCol > 0)
                    this.curCol -= 1;
                i += 1;
                continue;
            }
            // Skip other control chars
            if (ch < " " && ch !== "\t") {
                i += 1;
                continue;
            }
            // Printable char — write to buffer
            if (this.curRow < this.height) {
                const row = this.rows[this.curRow] ?? "";
                const padded = row.padEnd(this.curCol + 1, " ");
                this.rows[this.curRow] =
                    padded.slice(0, this.curCol) + ch + padded.slice(this.curCol + 1);
                this.curCol = Math.min(this.curCol + 1, this.width - 1);
            }
            i += 1;
        }
    }
    getScreen() {
        return this.rows.map((r) => r.trimEnd()).join("\n");
    }
    reset() {
        this.rows = Array.from({ length: this.height }, () => "");
        this.curRow = 0;
        this.curCol = 0;
    }
}
function sanitizePtyEnv(extra = {}) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") {
            env[key] = value;
        }
    }
    for (const [key, value] of Object.entries(extra)) {
        env[key] = value;
    }
    return env;
}
export class QwenRunner extends EventEmitter {
    provider = "qwen";
    sessions = new Map();
    on(event, fn) {
        return super.on(event, fn);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    startSession(options) {
        const { sessionId, projectPath, prompt, modelName, reasoningEffort, approvalMode, providerSessionId, timeoutMs = 0, } = options;
        let timer = null;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                log.debug(`${ts()} session ${sessionId} timed out`);
                this.cancelSession(sessionId);
            }, timeoutMs);
        }
        const entry = {
            id: sessionId,
            prompt,
            modelName,
            reasoningEffort,
            projectPath,
            approvalMode,
            status: "queued",
            startedAt: Date.now(),
            exitCode: null,
            pty: null,
            timeout: timer,
            pendingOptions: [],
            pendingRequestId: null,
            idleCompletionTimer: null,
            launchId: 0,
            providerSessionId: providerSessionId ?? sessionId,
            awaitingApproval: false,
            lastApprovalSignature: null,
            requestCounter: 0,
            ptyTracePath: null,
            ptyTraceStream: null,
            screen: new ScreenBuffer(),
            emittedToolSignatures: new Set(),
            pendingTextBlocks: new Map(),
            emittedTextBodies: new Set(),
            pendingAssistantText: "",
            emittedAssistantText: "",
            assistantEmitTimer: null,
            lastThinkingLabel: null,
        };
        this.ensureTrace(entry);
        this.sessions.set(sessionId, entry);
        this.launchProcess(entry, prompt, false);
    }
    resumeSession(options) {
        const { sessionId, projectPath, prompt, modelName, reasoningEffort, approvalMode, providerSessionId, } = options;
        const entry = {
            id: sessionId,
            prompt,
            modelName,
            reasoningEffort,
            projectPath,
            approvalMode,
            status: "idle",
            startedAt: Date.now(),
            exitCode: null,
            pty: null,
            timeout: null,
            pendingOptions: [],
            pendingRequestId: null,
            idleCompletionTimer: null,
            launchId: 0,
            providerSessionId: providerSessionId ?? sessionId,
            awaitingApproval: false,
            lastApprovalSignature: null,
            requestCounter: 0,
            ptyTracePath: null,
            ptyTraceStream: null,
            screen: new ScreenBuffer(),
            emittedToolSignatures: new Set(),
            pendingTextBlocks: new Map(),
            emittedTextBodies: new Set(),
            pendingAssistantText: "",
            emittedAssistantText: "",
            assistantEmitTimer: null,
            lastThinkingLabel: null,
        };
        this.ensureTrace(entry);
        this.sessions.set(sessionId, entry);
        this.launchProcess(entry, prompt, true);
    }
    respondToSession(sessionId, requestId, optionIndex) {
        const entry = this.sessions.get(sessionId);
        log.debug(`${ts()} respondToSession: sessionId=${sessionId}, requestId=${requestId}, optionIndex=${optionIndex}`);
        log.debug(`${ts()} respondToSession: entry=${!!entry}, pty=${!!entry?.pty}`);
        log.debug(`${ts()} respondToSession: pendingOptions=${JSON.stringify(entry?.pendingOptions)}`);
        if (!entry || !entry.pty) {
            log.debug(`${ts()} respondToSession: early return - no entry or pty`);
            return {
                ok: false,
                error: "Approval could not be resolved because the session is no longer active.",
            };
        }
        if (!entry.awaitingApproval || !entry.pendingRequestId) {
            return {
                ok: false,
                error: "Approval could not be resolved because there is no pending request.",
            };
        }
        if (entry.pendingRequestId !== requestId) {
            return {
                ok: false,
                error: "Approval could not be resolved because a newer request replaced it.",
            };
        }
        entry.awaitingApproval = false;
        entry.lastApprovalSignature = null;
        entry.pendingRequestId = null;
        const option = entry.pendingOptions[optionIndex];
        if (option?.shortcutKey) {
            // Standard case: QwenRunner detected the prompt and parsed options with shortcut keys
            const normalizedShortcut = option.shortcutKey.trim().toLowerCase();
            let input;
            if (normalizedShortcut === "esc") {
                input = "\x1b";
            }
            else if (normalizedShortcut === "enter") {
                input = "\r";
            }
            else if (normalizedShortcut === "y" ||
                normalizedShortcut === "n" ||
                normalizedShortcut === "yes" ||
                normalizedShortcut === "no") {
                input = `${normalizedShortcut.startsWith("y") ? "y" : "n"}\r`;
            }
            else {
                input = option.shortcutKey;
            }
            log.debug(`${ts()} respondToSession: sending shortcut input: ${JSON.stringify(input)}`);
            this.writeTrace(entry, "pty-input", {
                text: input,
                optionIndex,
                reason: "approval-shortcut",
            });
            entry.pty.write(input);
        }
        else if (entry.pendingOptions.length > 0) {
            // Standard case: QwenRunner detected the prompt, use arrow navigation
            log.debug(`${ts()} respondToSession: using arrow navigation (10 up, ${optionIndex} down, enter)`);
            this.writeTrace(entry, "pty-input", {
                text: "\\x1b[A x10, \\x1b[B x" + optionIndex + ", \\r",
                optionIndex,
                reason: "approval-navigation",
            });
            for (let i = 0; i < 10; i += 1) {
                entry.pty.write("\x1b[A");
            }
            for (let i = 0; i < optionIndex; i += 1) {
                entry.pty.write("\x1b[B");
            }
            entry.pty.write("\r");
        }
        else {
            // Auto-detected approval from edge function: pendingOptions is empty
            // Send a direct y/n response to Qwen CLI
            const response = optionIndex === 0 ? "y" : "n";
            log.debug(`${ts()} respondToSession: auto-detected approval, sending "${response}"`);
            this.writeTrace(entry, "pty-input", {
                text: `${response}\\r`,
                optionIndex,
                reason: "approval-yes-no",
            });
            entry.pty.write(`${response}\r`);
        }
        entry.pendingOptions = [];
        if (entry.status === "busy") {
            entry.status = "running";
            this.emit("status", sessionId, "running");
        }
        log.debug(`${ts()} respondToSession: cleared pendingOptions, returning true`);
        return { ok: true };
    }
    inputToSession(sessionId, text, modelName, _planMode, reasoningEffort, approvalMode, _attachments) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return false;
        }
        if (entry.idleCompletionTimer) {
            clearTimeout(entry.idleCompletionTimer);
            entry.idleCompletionTimer = null;
        }
        if (entry.status === "idle") {
            if (modelName) {
                entry.modelName = modelName;
            }
            if (reasoningEffort) {
                entry.reasoningEffort = reasoningEffort;
            }
            if (approvalMode) {
                entry.approvalMode = approvalMode;
            }
            this.launchProcess(entry, text, true);
            return true;
        }
        if (modelName) {
            entry.modelName = modelName;
        }
        if (reasoningEffort) {
            entry.reasoningEffort = reasoningEffort;
        }
        if (approvalMode) {
            entry.approvalMode = approvalMode;
        }
        if (!entry.pty) {
            return false;
        }
        this.writeTrace(entry, "pty-input", { text });
        entry.pty.write(`${text}\r`);
        return true;
    }
    cancelSession(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return false;
        }
        entry.status = "cancelled";
        this.emit("status", sessionId, "cancelled");
        if (entry.timeout) {
            clearTimeout(entry.timeout);
            entry.timeout = null;
        }
        if (entry.idleCompletionTimer) {
            clearTimeout(entry.idleCompletionTimer);
            entry.idleCompletionTimer = null;
        }
        this.flushPendingAssistantText(entry);
        if (!entry.pty) {
            const duration = Date.now() - entry.startedAt;
            this.emit("complete", sessionId, 130, duration);
            this.closeTrace(entry);
            this.sessions.delete(sessionId);
            return true;
        }
        try {
            entry.pty.kill();
        }
        catch {
            // Process may have already exited.
        }
        return true;
    }
    finishSession(sessionId) {
        const entry = this.sessions.get(sessionId);
        if (!entry) {
            return false;
        }
        if (entry.timeout) {
            clearTimeout(entry.timeout);
            entry.timeout = null;
        }
        if (entry.idleCompletionTimer) {
            clearTimeout(entry.idleCompletionTimer);
            entry.idleCompletionTimer = null;
        }
        this.flushPendingAssistantText(entry);
        entry.pendingOptions = [];
        entry.pendingRequestId = null;
        entry.awaitingApproval = false;
        entry.lastApprovalSignature = null;
        entry.status = "completed";
        this.emit("status", sessionId, "completed");
        const duration = Date.now() - entry.startedAt;
        if (entry.pty) {
            const processPty = entry.pty;
            entry.pty = null;
            try {
                processPty.kill();
            }
            catch {
                // Process may already have exited.
            }
        }
        this.emit("complete", sessionId, 0, duration);
        this.closeTrace(entry);
        this.sessions.delete(sessionId);
        return true;
    }
    killAll() {
        for (const [id] of this.sessions) {
            this.cancelSession(id);
        }
    }
    launchProcess(entry, prompt, resume) {
        const args = this.buildArgs(prompt, entry.approvalMode, resume, entry.providerSessionId);
        log.debug(`${ts()} session ${entry.id} - qwen ${args.join(" ")}`);
        log.debug(`${ts()} cwd: ${entry.projectPath}`);
        const isWin = process.platform === "win32";
        const resolvedQwen = isWin ? null : resolveExecutable("qwen");
        if (!existsSync(entry.projectPath)) {
            const detail = `Failed to launch Qwen PTY because the working directory does not exist: ${entry.projectPath}`;
            entry.status = "failed";
            this.writeTrace(entry, "launch-error", {
                shell: null,
                shellArgs: null,
                cwd: entry.projectPath,
                message: detail,
            });
            this.emit("error", entry.id, detail);
            this.emit("status", entry.id, "failed");
            this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
            this.closeTrace(entry);
            this.sessions.delete(entry.id);
            return;
        }
        this.writeTrace(entry, "launch", {
            resume,
            args,
            cwd: entry.projectPath,
            providerSessionId: entry.providerSessionId,
            resolvedExecutable: resolvedQwen,
        });
        const unixCommand = `exec ${buildShellCommand("qwen", args)}`;
        const unixShell = getShellLaunch();
        const shell = isWin ? "cmd.exe" : unixShell.shell;
        const shellArgs = isWin ? ["/c", "qwen", ...args] : unixShell.argsForCommand(unixCommand);
        if (!isWin && !resolvedQwen) {
            const detail = "Failed to launch Qwen PTY because the qwen binary could not be resolved from the login shell PATH.";
            entry.status = "failed";
            this.writeTrace(entry, "launch-error", {
                shell,
                shellArgs,
                cwd: entry.projectPath,
                message: detail,
            });
            this.emit("error", entry.id, detail);
            this.emit("status", entry.id, "failed");
            this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
            this.closeTrace(entry);
            this.sessions.delete(entry.id);
            return;
        }
        let processPty;
        try {
            processPty = pty.spawn(shell, shellArgs, {
                name: "xterm-256color",
                cols: 120,
                rows: 40,
                cwd: entry.projectPath,
                env: sanitizePtyEnv(),
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const detail = `Failed to launch Qwen PTY (shell=${shell}, cwd=${entry.projectPath}). ${message}`;
            entry.status = "failed";
            this.writeTrace(entry, "launch-error", { shell, shellArgs, cwd: entry.projectPath, message });
            this.emit("error", entry.id, detail);
            this.emit("status", entry.id, "failed");
            this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
            this.closeTrace(entry);
            this.sessions.delete(entry.id);
            return;
        }
        entry.launchId += 1;
        const launchId = entry.launchId;
        entry.pty = processPty;
        entry.pendingOptions = [];
        entry.pendingRequestId = null;
        entry.awaitingApproval = false;
        entry.lastApprovalSignature = null;
        entry.status = "running";
        entry.prompt = prompt;
        this.emit("status", entry.id, "running");
        this.emit("providerSession", entry.id, entry.providerSessionId);
        processPty.onData((data) => {
            const current = this.sessions.get(entry.id);
            if (!current || current.launchId !== launchId || current.pty !== processPty) {
                return;
            }
            this.emit("output", entry.id, data);
            this.writeTrace(current, "pty-output", { data });
            current.screen.write(data);
            const clean = current.screen.getScreen();
            this.parseScreenBlocks(current, clean);
            const parsed = this.parsePrompt(clean);
            if (parsed) {
                this.raiseApproval(current, parsed.contextText, parsed.options);
                // Reset screen after approval so next turn starts fresh.
                current.screen.reset();
            }
            else {
                const genericApprovalMessage = this.detectGenericApproval(clean);
                if (genericApprovalMessage) {
                    this.raiseApproval(current, genericApprovalMessage, [
                        { index: 0, label: "Accept", shortcutKey: "y" },
                        { index: 1, label: "Reject", shortcutKey: "n" },
                    ]);
                    current.screen.reset();
                }
            }
            if (current.idleCompletionTimer) {
                clearTimeout(current.idleCompletionTimer);
                current.idleCompletionTimer = null;
            }
            if (!current.awaitingApproval && Date.now() - current.startedAt > 15_000) {
                current.idleCompletionTimer = setTimeout(() => {
                    const latest = this.sessions.get(entry.id);
                    if (!latest ||
                        latest.launchId !== launchId ||
                        latest.pty !== processPty ||
                        latest.status !== "running" ||
                        latest.awaitingApproval) {
                        return;
                    }
                    log.debug(`${ts()} session ${entry.id} - no PTY output for 15s, marking idle`);
                    this.flushPendingAssistantText(latest);
                    latest.status = "idle";
                    latest.pendingOptions = [];
                    latest.pendingRequestId = null;
                    latest.awaitingApproval = false;
                    latest.lastApprovalSignature = null;
                    latest.pty = null;
                    this.emit("status", entry.id, "idle");
                    try {
                        processPty.kill();
                    }
                    catch {
                        // Process may already have exited.
                    }
                }, 15_000);
            }
        });
        processPty.onExit(({ exitCode }) => {
            log.debug(`${ts()} session ${entry.id} exited code=${exitCode}`);
            const current = this.sessions.get(entry.id);
            if (!current) {
                return;
            }
            if (current.launchId !== launchId || current.pty !== processPty) {
                return;
            }
            current.pty = null;
            current.pendingOptions = [];
            current.pendingRequestId = null;
            current.awaitingApproval = false;
            current.lastApprovalSignature = null;
            if (current.idleCompletionTimer) {
                clearTimeout(current.idleCompletionTimer);
                current.idleCompletionTimer = null;
            }
            const duration = Date.now() - current.startedAt;
            current.exitCode = exitCode;
            if (current.status === "cancelled") {
                if (current.timeout) {
                    clearTimeout(current.timeout);
                    current.timeout = null;
                }
                this.emit("complete", entry.id, exitCode, duration);
                this.closeTrace(current);
                this.sessions.delete(entry.id);
                return;
            }
            if (exitCode === 0) {
                this.flushPendingAssistantText(current);
                current.status = "idle";
                this.emit("status", entry.id, "idle");
                return;
            }
            if (current.timeout) {
                clearTimeout(current.timeout);
                current.timeout = null;
            }
            current.status = "failed";
            this.emit("status", entry.id, "failed");
            this.emit("complete", entry.id, exitCode, duration);
            this.closeTrace(current);
            this.sessions.delete(entry.id);
        });
    }
    buildArgs(prompt, mode, resume, providerSessionId) {
        const args = ["--approval-mode", this.mapApprovalMode(mode)];
        if (resume) {
            args.push("--resume", providerSessionId);
        }
        else {
            args.push("--session-id", providerSessionId);
        }
        args.push("-i", prompt);
        return args;
    }
    mapApprovalMode(mode) {
        if (mode === "full-auto") {
            return "yolo";
        }
        if (mode === "auto-edit") {
            return "auto-edit";
        }
        return "default";
    }
    normalizeApprovalLine(line) {
        return line
            .replace(/^\s*[│|]\s?/, "")
            .replace(/\s?[│|]\s*$/, "")
            .replace(/^\s*[›❯>]\s*/, "")
            .replace(/^\s*[?]\s+/, "")
            .replace(/\s+/g, " ")
            .trim();
    }
    isApprovalNoiseLine(line) {
        if (!line) {
            return true;
        }
        return (/^(?:approval|permission)\s+required$/i.test(line) ||
            /^apply\s+this\s+change\??$/i.test(line) ||
            /^waiting\s+for\s+(?:approval|user|confirmation)/i.test(line) ||
            /^(?:thinking|analyzing|reasoning|working|loading|searching|mining)\b/i.test(line) ||
            /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line));
    }
    isApprovalActionLine(line) {
        return (/^(?:Edit|Write|WriteFile|MultiEdit|Replace|CreateFile|ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory|Grep|Glob|Search|SearchText|Shell|Bash|Run|Fetch|WebFetch)\b/.test(line) ||
            /^(?:Command|File|Path)\s*:/i.test(line) ||
            /(?:^|[ "'`])(?:[A-Za-z]:\\|\/)?[\w./\\-]+\.[A-Za-z0-9]+(?::\d+)?(?:[ "'`]|$)/.test(line) ||
            /(?:powershell|cmd(?:\.exe)?|bash|sh|npm|pnpm|yarn|node|python|git|sed|cat|rm|mv|cp)\b/i.test(line));
    }
    buildApprovalDisplay(contextText) {
        const lines = contextText
            .split("\n")
            .map((line) => this.normalizeApprovalLine(line))
            .filter(Boolean);
        const filtered = lines.filter((line) => !this.isApprovalNoiseLine(line));
        const actionLine = filtered.find((line) => this.isApprovalActionLine(line)) ?? null;
        if (actionLine) {
            const messageLines = filtered.filter((line) => line !== actionLine);
            return {
                title: actionLine.length <= 120 ? actionLine : `${actionLine.slice(0, 117)}...`,
                message: messageLines.join("\n") || actionLine,
            };
        }
        if (filtered.length >= 2 && filtered[0].length <= 80) {
            return {
                title: filtered[0],
                message: filtered.slice(1).join("\n"),
            };
        }
        const fallback = filtered[0] ?? lines[0] ?? "Qwen requires confirmation";
        return {
            title: null,
            message: fallback.length <= 220 ? fallback : `${fallback.slice(0, 217)}...`,
        };
    }
    /**
     * Extracts the content of the approval box surrounding the options block.
     * Looks upward from the options lines until a ╭ border is found, and joins
     * the inner lines (stripping "│" borders and excess whitespace). This keeps
     * the tool header (e.g. "?  Edit App.tsx:…") and the diff preview so the
     * mobile approval popup can display what exactly is being asked.
     */
    extractApprovalBoxContent(lines, blockStart, blockEnd) {
        let top = -1;
        for (let i = blockStart - 1; i >= Math.max(0, blockStart - 120); i -= 1) {
            const raw = lines[i];
            if (/^\s*╭/.test(raw)) {
                top = i;
                break;
            }
        }
        if (top < 0)
            return null;
        let bottom = -1;
        for (let i = blockEnd + 1; i < Math.min(lines.length, blockEnd + 40); i += 1) {
            const raw = lines[i];
            if (/^\s*╰/.test(raw)) {
                bottom = i;
                break;
            }
        }
        if (bottom < 0)
            bottom = Math.min(lines.length - 1, blockEnd + 20);
        const inner = [];
        for (let i = top + 1; i < bottom; i += 1) {
            const raw = lines[i];
            let cleaned = raw
                .replace(/^\s*│\s?/, "")
                .replace(/\s?│\s*$/, "")
                .replace(/\s+$/, "");
            cleaned = cleaned.replace(/^\s*›\s*/, "");
            if (/^\s*$/.test(cleaned)) {
                if (inner.length && inner[inner.length - 1] !== "")
                    inner.push("");
                continue;
            }
            if (this.isApprovalNoiseLine(this.normalizeApprovalLine(cleaned)) && inner.length === 0) {
                continue;
            }
            // Stop before numbered choice options (they're already sent as options).
            if (/^\s*\d+\.\s/.test(cleaned))
                break;
            if (/^Apply this change\??$/i.test(cleaned.trim())) {
                inner.push(cleaned.trim());
                break;
            }
            inner.push(cleaned);
        }
        // Drop trailing blanks.
        while (inner.length && inner[inner.length - 1] === "")
            inner.pop();
        return inner.length ? inner.join("\n") : null;
    }
    parsePrompt(text) {
        const lines = text
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n")
            .slice(-80)
            .map((line) => line.trimEnd());
        const optionMatcher = /^(?:\s*(?:\u203a|\u276f|>|->|\*)\s*)?(\d+)[.)]\s+(.+?)(?:\s+\(([\w-]+)\))?\s*$/;
        const hasCursorPrefix = (line) => /^\s*(?:\u203a|\u276f|>|->|\*)\s*/.test(line);
        const isDescriptionLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed || optionMatcher.test(trimmed)) {
                return false;
            }
            return (/^\s{2,}\S/.test(line) ||
                /^[a-z]/.test(trimmed) ||
                /\b(recommended|default|faster|safer|impact|tradeoff)\b/i.test(trimmed));
        };
        let blockStart = -1;
        let blockHasCursor = false;
        let blockOptions = [];
        let bestStart = -1;
        let bestEnd = -1;
        let bestHasCursor = false;
        let bestOptions = [];
        const commitBlock = (endExclusive) => {
            if (blockOptions.length >= 2) {
                bestStart = blockStart;
                bestEnd = endExclusive - 1;
                bestHasCursor = blockHasCursor;
                bestOptions = [...blockOptions];
            }
            blockStart = -1;
            blockHasCursor = false;
            blockOptions = [];
        };
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const match = line.match(optionMatcher);
            if (!match) {
                if (blockOptions.length > 0 && isDescriptionLine(line)) {
                    continue;
                }
                if (blockOptions.length > 0) {
                    commitBlock(index);
                }
                continue;
            }
            const optionNumber = Number(match[1]);
            const label = match[2].trim();
            const shortcutKey = match[3] ?? null;
            const hasCursor = hasCursorPrefix(line);
            if (!label) {
                if (blockOptions.length > 0) {
                    commitBlock(index);
                }
                continue;
            }
            if (blockOptions.length === 0) {
                if (optionNumber !== 1) {
                    continue;
                }
                blockStart = index;
                blockHasCursor = hasCursor;
                blockOptions.push({
                    index: 0,
                    label,
                    shortcutKey,
                });
                continue;
            }
            const expectedNumber = blockOptions.length + 1;
            if (optionNumber !== expectedNumber) {
                commitBlock(index);
                if (optionNumber !== 1) {
                    continue;
                }
                blockStart = index;
                blockHasCursor = hasCursor;
                blockOptions.push({
                    index: 0,
                    label,
                    shortcutKey,
                });
                continue;
            }
            blockHasCursor ||= hasCursor;
            blockOptions.push({
                index: blockOptions.length,
                label,
                shortcutKey,
            });
        }
        if (blockOptions.length > 0) {
            commitBlock(lines.length);
        }
        if (bestOptions.length < 2 || bestStart === -1 || bestEnd === -1) {
            return null;
        }
        const contextLines = [];
        for (let index = bestStart - 1; index >= 0; index -= 1) {
            const line = lines[index].trim();
            if (!line) {
                if (contextLines.length > 0) {
                    break;
                }
                continue;
            }
            contextLines.unshift(line);
            if (contextLines.length >= 8) {
                break;
            }
        }
        const contextText = contextLines.join("\n").trim();
        const region = lines
            .slice(Math.max(0, bestStart - 8), bestEnd + 1)
            .join("\n")
            .trim();
        const lastContextLine = contextLines.at(-1) ?? "";
        const looksInteractive = bestHasCursor ||
            bestOptions.some((option) => option.shortcutKey) ||
            /[?]\s*$/.test(lastContextLine) ||
            /\b(recommended|select one|choose one|pick one|press enter to submit|esc to cancel|answer the following|question)\b/i.test(`${contextText}\n${region}`) ||
            /\b(choose|pick|select|which|prefer|option|recommended|continue|confirm|allow|approve|answer|respond|question|what should i|would you like|how should i|autoriser|choisir|quelle option|quel choix|continuer|confirmer|repondre|r??pondre)\b/i.test(`${contextText}\n${region}`);
        if (!looksInteractive) {
            return null;
        }
        const boxContent = this.extractApprovalBoxContent(lines, bestStart, bestEnd);
        return {
            contextText: boxContent ?? contextText ?? region,
            options: bestOptions,
        };
    }
    detectGenericApproval(text) {
        const normalized = text
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .trim();
        if (!normalized) {
            return null;
        }
        const approvalPatterns = [
            /waiting\s+for\s+user\s+confirmation/i,
            /waiting\s+for\s+approval/i,
            /user\s+confirmation\s+required/i,
            /approval\s+required/i,
            /confirm\s+this\s+action/i,
            /do\s+you\s+want\s+to\s+(proceed|continue|apply)/i,
            /\b(?:approve|approval|confirm|confirmation)\b/i,
        ];
        if (!approvalPatterns.some((pattern) => pattern.test(normalized))) {
            return null;
        }
        const lines = normalized
            .split("\n")
            .map((line) => this.normalizeApprovalLine(line))
            .filter(Boolean);
        const relevantLines = lines.filter((line) => !this.isApprovalNoiseLine(line) && line.length > 3);
        const actionLine = relevantLines.find((line) => this.isApprovalActionLine(line));
        const contextLine = actionLine ??
            relevantLines[0] ??
            lines[0] ??
            "Qwen requires confirmation";
        return contextLine.length > 220 ? `${contextLine.slice(0, 217)}...` : contextLine;
    }
    raiseApproval(entry, message, options) {
        if (entry.approvalMode === "full-auto") {
            log.debug(`${ts()} auto-approving prompt in YOLO mode`);
            entry.pendingOptions = options;
            entry.pendingRequestId = null;
            entry.awaitingApproval = false;
            entry.lastApprovalSignature = null;
            this.respondToDetectedApproval(entry, 0);
            return;
        }
        const textParts = this.extractApprovalTextParts(message);
        const signature = `${textParts.title ?? ""}::${textParts.message}::${options
            .map((option) => `${option.index}:${option.label}:${option.shortcutKey ?? ""}`)
            .join("|")}`;
        if (entry.awaitingApproval && entry.lastApprovalSignature === signature) {
            return;
        }
        log.debug(`${ts()} approval detected (${options.length} opts)`);
        entry.requestCounter += 1;
        entry.pendingOptions = options;
        entry.pendingRequestId = `${entry.id}-approval-${entry.requestCounter}`;
        entry.awaitingApproval = true;
        entry.lastApprovalSignature = signature;
        entry.status = "busy";
        this.emit("status", entry.id, "busy");
        this.emit("approval", entry.id, entry.pendingRequestId, textParts.title, textParts.message, options);
    }
    respondToDetectedApproval(entry, optionIndex) {
        if (!entry.pty) {
            return;
        }
        const option = entry.pendingOptions[optionIndex];
        if (option?.shortcutKey) {
            const normalizedShortcut = option.shortcutKey.trim().toLowerCase();
            let input;
            if (normalizedShortcut === "esc") {
                input = "\x1b";
            }
            else if (normalizedShortcut === "enter") {
                input = "\r";
            }
            else if (normalizedShortcut === "y" ||
                normalizedShortcut === "n" ||
                normalizedShortcut === "yes" ||
                normalizedShortcut === "no") {
                input = `${normalizedShortcut.startsWith("y") ? "y" : "n"}\r`;
            }
            else {
                input = option.shortcutKey;
            }
            entry.pty.write(input);
            this.writeTrace(entry, "pty-input", {
                text: input,
                optionIndex,
                reason: "auto-approval-shortcut",
            });
        }
        else if (entry.pendingOptions.length > 0) {
            this.writeTrace(entry, "pty-input", {
                text: "\\x1b[A x10, \\x1b[B x" + optionIndex + ", \\r",
                optionIndex,
                reason: "auto-approval-navigation",
            });
            for (let i = 0; i < 10; i += 1) {
                entry.pty.write("\x1b[A");
            }
            for (let i = 0; i < optionIndex; i += 1) {
                entry.pty.write("\x1b[B");
            }
            entry.pty.write("\r");
        }
        else {
            this.writeTrace(entry, "pty-input", {
                text: `${optionIndex === 0 ? "y" : "n"}\\r`,
                optionIndex,
                reason: "auto-approval-yes-no",
            });
            entry.pty.write(`${optionIndex === 0 ? "y" : "n"}\r`);
        }
        entry.pendingOptions = [];
        entry.pendingRequestId = null;
    }
    extractApprovalTextParts(contextText) {
        return this.buildApprovalDisplay(contextText);
    }
    emitBlock(entry, kind, title, body, metadata) {
        const block = {
            kind,
            body,
            ...(title ? { title } : {}),
            ...(metadata ? { metadata } : {}),
        };
        this.emit("readableBlock", entry.id, block);
    }
    flushPendingAssistantText(entry) {
        // Flush any legacy single-text pending
        if (entry.assistantEmitTimer) {
            clearTimeout(entry.assistantEmitTimer);
            entry.assistantEmitTimer = null;
        }
        // Flush all pending text blocks
        for (const [key, pending] of entry.pendingTextBlocks) {
            if (pending.timer) {
                clearTimeout(pending.timer);
            }
            if (pending.text && !entry.emittedTextBodies.has(pending.text)) {
                this.emitBlock(entry, "text", null, pending.text);
                entry.emittedTextBodies.add(pending.text);
            }
        }
        entry.pendingTextBlocks.clear();
        entry.pendingAssistantText = "";
    }
    /**
     * Parses the current cleaned PTY screen to extract displayable blocks.
     * - Tool calls (Grep/Glob/ReadFile/Shell/Edit/Write) → command/code/path blocks.
     * - Assistant text (lines starting with ✦) → text block (debounced).
     * - Spinner status text (⠋ Looking for a misplaced semicolon…) → thinking block.
     * Deduplicates via signatures stored on the entry.
     */
    parseScreenBlocks(entry, clean) {
        const lines = clean.split("\n");
        // ── 1. Tool calls ────────────────────────────────────────────────────────
        // Pattern: "│ ✓  ToolName args…" inside boxes.
        // We only emit on completed icons (✓ ✎ ✔ ✗ ✖), not in-progress (⊶ ⧖ ⚡).
        const toolLineRe = /[│|]\s*([✓✎⊶⧖⚡✗✖✔●])\s+(Grep|Glob|Shell|ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory|Edit|Write|WriteFile|FindFiles|Search|SearchText|FileSystem|Bash|Run|MultiEdit|Replace|Todo|Task|Fetch|WebFetch|CreateFile)\b([^\n]*?)(?:\s*[│|])?$/;
        for (const rawLine of lines) {
            const match = rawLine.match(toolLineRe);
            if (!match)
                continue;
            const [, icon, tool, rawArgs] = match;
            if (icon === "⊶" || icon === "⧖" || icon === "⚡")
                continue;
            const args = rawArgs.trim().replace(/…$/, "").trim();
            if (!args)
                continue;
            const signature = `tool:${tool}:${args}`;
            if (entry.emittedToolSignatures.has(signature))
                continue;
            entry.emittedToolSignatures.add(signature);
            const editLike = /^(Edit|Write|WriteFile|MultiEdit|Replace|CreateFile)$/.test(tool);
            const readLike = /^(ReadFile|ReadFolder|ReadManyFiles|ListFiles|ListDirectory)$/.test(tool);
            if (editLike) {
                const filePath = (args.match(/^([^\s:]+)/) ?? [null, args])[1];
                this.emitBlock(entry, "code", filePath, args, { tool, filePath });
            }
            else if (readLike) {
                const filePath = (args.match(/^['""]?([^'""\s]+)['""]?/) ?? [null, args])[1];
                this.emitBlock(entry, "path", tool, filePath, { tool });
            }
            else {
                this.emitBlock(entry, "command", tool, args, { tool });
            }
        }
        // ── 2. Assistant text ────────────────────────────────────────────────────
        // The screen may show multiple ✦ blocks (chat history). Each is a separate
        // text block. We collect all of them, track the longest capture per prefix
        // key, and emit each once after 3s of stability.
        const assistantBlocks = this.collectAssistantBlocks(lines);
        for (const text of assistantBlocks) {
            if (!text || entry.emittedTextBodies.has(text))
                continue;
            // Use the first 40 chars (normalized) as a stable key for a growing text.
            const key = text.slice(0, 40);
            const existing = entry.pendingTextBlocks.get(key);
            if (existing) {
                if (text.length > existing.text.length) {
                    existing.text = text;
                    // Reset stability timer.
                    if (existing.timer)
                        clearTimeout(existing.timer);
                    existing.timer = setTimeout(() => {
                        const latest = this.sessions.get(entry.id);
                        if (!latest)
                            return;
                        const slot = latest.pendingTextBlocks.get(key);
                        if (slot && !latest.emittedTextBodies.has(slot.text)) {
                            this.emitBlock(latest, "text", null, slot.text);
                            latest.emittedTextBodies.add(slot.text);
                        }
                        latest.pendingTextBlocks.delete(key);
                    }, 3000);
                }
                // Text is shorter or same — ignore (reflow artifact).
            }
            else {
                // New text block — start tracking.
                const timer = setTimeout(() => {
                    const latest = this.sessions.get(entry.id);
                    if (!latest)
                        return;
                    const slot = latest.pendingTextBlocks.get(key);
                    if (slot && !latest.emittedTextBodies.has(slot.text)) {
                        this.emitBlock(latest, "text", null, slot.text);
                        latest.emittedTextBodies.add(slot.text);
                    }
                    latest.pendingTextBlocks.delete(key);
                }, 3000);
                entry.pendingTextBlocks.set(key, { text, timer });
            }
        }
        // ── 3. Spinner / thinking label ──────────────────────────────────────────
        const thinkingMatch = clean.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+([A-Za-zÀ-ÿ][^\n(]{2,80}?)(?:\s*\(|\s*\.{2,3}|\n|$)/);
        if (thinkingMatch) {
            const label = thinkingMatch[1].trim();
            if (label &&
                label !== entry.lastThinkingLabel &&
                !/waiting for user/i.test(label) &&
                !/initializing/i.test(label) &&
                !/dial-up/i.test(label) &&
                !/snozberr/i.test(label) &&
                !/microchip/i.test(label)) {
                entry.lastThinkingLabel = label;
                this.emitBlock(entry, "thinking", null, label);
            }
        }
    }
    /**
     * Collect all ✦-prefixed text blocks from screen lines.
     * Each block starts at a ✦ line and continues with indented continuation lines.
     */
    collectAssistantBlocks(lines) {
        const blocks = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (/^\s{0,4}✦\s+/.test(line)) {
                const collected = [];
                const startLine = line.replace(/^\s{0,4}✦\s+/, "").trimEnd();
                if (startLine)
                    collected.push(startLine);
                i += 1;
                // Continuation lines: 4+ space indented, not a new ✦, not a border/spinner.
                while (i < lines.length) {
                    const next = lines[i];
                    if (!next || next.trim() === "")
                        break;
                    if (/^\s{0,4}✦\s+/.test(next))
                        break; // next assistant block
                    if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(next))
                        break; // spinner
                    if (/^[─━]{5,}/.test(next.trim()))
                        break; // separator line
                    if (/^[╭╮╯╰│]/.test(next.trim()))
                        break; // box border
                    if (/^[>│]/.test(next.trim()))
                        break; // input prompt
                    // Must be indented continuation
                    if (/^\s{4}/.test(next)) {
                        collected.push(next.replace(/^\s+/, "").trimEnd());
                        i += 1;
                    }
                    else {
                        break;
                    }
                }
                const text = collected.join(" ").replace(/\s{2,}/g, " ").trim();
                if (text.length >= 10)
                    blocks.push(text);
            }
            else {
                i += 1;
            }
        }
        return blocks;
    }
    stripAnsi(value) {
        return value
            .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
            .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
            .replace(/\r\n/g, "\n")
            .replace(/\r(?!\n)/g, "\n")
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
            .replace(/\u001b/g, "");
    }
    ensureTrace(entry) {
        if (entry.ptyTraceStream && entry.ptyTracePath) {
            return;
        }
        const logsDir = path.join(homedir(), ".openremote", "pty-logs");
        mkdirSync(logsDir, { recursive: true });
        const tracePath = path.join(logsDir, `${entry.id}-${Date.now()}-qwen.jsonl`);
        entry.ptyTracePath = tracePath;
        entry.ptyTraceStream = createWriteStream(tracePath, { flags: "a" });
        this.writeTrace(entry, "trace-start", {
            sessionId: entry.id,
            projectPath: entry.projectPath,
            provider: "qwen",
            tracePath,
        });
        this.emit("sessionLog", entry.id, tracePath);
        log.debug(`${ts()} session ${entry.id} - PTY trace ${tracePath}`);
    }
    writeTrace(entry, event, payload) {
        if (!entry.ptyTraceStream) {
            return;
        }
        entry.ptyTraceStream.write(`${JSON.stringify({
            ts: new Date().toISOString(),
            event,
            ...payload,
        })}\n`);
    }
    closeTrace(entry) {
        if (!entry.ptyTraceStream) {
            return;
        }
        this.writeTrace(entry, "trace-end", { sessionId: entry.id, status: entry.status });
        entry.ptyTraceStream.end();
        entry.ptyTraceStream = null;
    }
}
//# sourceMappingURL=qwen-runner.js.map