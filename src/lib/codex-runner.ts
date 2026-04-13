import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { findCodexSessionIdForProject } from "./codex-session-store.js";
import { log } from "./logger.js";
import type { ParsedOption, RunnerEvents, SessionStatus } from "./types.js";

function ts() {
  return `[${new Date().toISOString()}] [runner]`;
}

interface SessionEntry {
  id: string;
  prompt: string;
  modelName: string;
  reasoningEffort: string;
  projectPath: string;
  approvalMode: "full-auto" | "auto-edit" | "suggest";
  status: SessionStatus;
  startedAt: number;
  exitCode: number | null;
  apiKey: string;
  pty: pty.IPty | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pendingOptions: ParsedOption[];
  idleCompletionTimer: ReturnType<typeof setTimeout> | null;
  launchId: number;
  codexSessionId: string | null;
  discoveryTimer: ReturnType<typeof setInterval> | null;
}

export class CodexRunner extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();

  override on<K extends keyof RunnerEvents>(event: K, fn: RunnerEvents[K]): this {
    return super.on(event, fn);
  }

  override emit<K extends keyof RunnerEvents>(
    event: K,
    ...args: Parameters<RunnerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  startSession(
    sessionId: string,
    projectPath: string,
    prompt: string,
    modelName: string,
    reasoningEffort: string,
    approvalMode: "full-auto" | "auto-edit" | "suggest",
    apiKey: string,
    codexSessionId: string | null = null,
    timeoutMs = 0,
  ): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        log.debug(`${ts()} session ${sessionId} timed out`);
        this.cancelSession(sessionId);
      }, timeoutMs);
    }

    const entry: SessionEntry = {
      id: sessionId,
      prompt,
      modelName,
      reasoningEffort,
      projectPath,
      approvalMode,
      status: "queued",
      startedAt: Date.now(),
      exitCode: null,
      apiKey,
      pty: null,
      timeout: timer,
      pendingOptions: [],
      idleCompletionTimer: null,
      launchId: 0,
      codexSessionId,
      discoveryTimer: null,
    };

    this.sessions.set(sessionId, entry);
    this.launchProcess(entry, prompt, false);
  }

  resumeSession(
    sessionId: string,
    projectPath: string,
    prompt: string,
    modelName: string,
    reasoningEffort: string,
    approvalMode: "full-auto" | "auto-edit" | "suggest",
    apiKey: string,
    codexSessionId: string | null = null,
  ): void {
    const entry: SessionEntry = {
      id: sessionId,
      prompt,
      modelName,
      reasoningEffort,
      projectPath,
      approvalMode,
      status: "idle",
      startedAt: Date.now(),
      exitCode: null,
      apiKey,
      pty: null,
      timeout: null,
      pendingOptions: [],
      idleCompletionTimer: null,
      launchId: 0,
      codexSessionId,
      discoveryTimer: null,
    };

    this.sessions.set(sessionId, entry);
    this.launchProcess(entry, prompt, true);
  }

  respondToSession(sessionId: string, optionIndex: number): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.pty) {
      return false;
    }

    const option = entry.pendingOptions[optionIndex];
    if (option?.shortcutKey) {
      const key = option.shortcutKey === "esc" ? "\x1b" : option.shortcutKey;
      entry.pty.write(key);
    } else {
      for (let i = 0; i < 10; i += 1) {
        entry.pty.write("\x1b[A");
      }
      for (let i = 0; i < optionIndex; i += 1) {
        entry.pty.write("\x1b[B");
      }
      entry.pty.write("\r");
    }

    entry.pendingOptions = [];
    return true;
  }

  inputToSession(
    sessionId: string,
    text: string,
    modelName?: string,
    reasoningEffort?: string,
  ): boolean {
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
      this.launchProcess(entry, text, true);
      return true;
    }

    if (modelName) {
      entry.modelName = modelName;
    }
    if (reasoningEffort) {
      entry.reasoningEffort = reasoningEffort;
    }

    if (!entry.pty) {
      return false;
    }

    entry.pty.write(text + "\r");
    return true;
  }

  cancelSession(sessionId: string): boolean {
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
    if (entry.discoveryTimer) {
      clearInterval(entry.discoveryTimer);
      entry.discoveryTimer = null;
    }

    if (!entry.pty) {
      const duration = Date.now() - entry.startedAt;
      this.emit("complete", sessionId, 130, duration);
      this.sessions.delete(sessionId);
      return true;
    }

    try {
      entry.pty.kill();
    } catch {
      // Process may have already exited.
    }

    return true;
  }

  finishSession(sessionId: string): boolean {
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
    if (entry.discoveryTimer) {
      clearInterval(entry.discoveryTimer);
      entry.discoveryTimer = null;
    }

    entry.pendingOptions = [];
    entry.status = "completed";
    this.emit("status", sessionId, "completed");

    const duration = Date.now() - entry.startedAt;

    if (entry.pty) {
      const processPty = entry.pty;
      entry.pty = null;
      try {
        processPty.kill();
      } catch {
        // Process may already have exited.
      }
    }

    this.emit("complete", sessionId, 0, duration);
    this.sessions.delete(sessionId);
    return true;
  }

  hasActiveSession(): boolean {
    return this.sessions.size > 0;
  }

  getActiveSessionId(): string | null {
    const first = this.sessions.keys().next();
    return first.done ? null : first.value;
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.cancelSession(id);
    }
  }

  private launchProcess(entry: SessionEntry, prompt: string, resume: boolean): void {
    const args = this.buildArgs(
      prompt,
      entry.modelName,
      entry.reasoningEffort,
      entry.approvalMode,
      resume,
      entry.codexSessionId,
    );
    log.debug(`${ts()} session ${entry.id} - codex ${args.join(" ")}`);
    log.debug(`${ts()} cwd: ${entry.projectPath}`);

    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/bash";
    const shellArgs = isWin
      ? ["/c", "codex", ...args]
      : [
          "-c",
          `codex ${args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ")}`,
        ];

    const processPty = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: entry.projectPath,
      env: { ...process.env, OPENAI_API_KEY: entry.apiKey } as Record<string, string>,
    });

    entry.launchId += 1;
    const launchId = entry.launchId;
    entry.pty = processPty;
    entry.pendingOptions = [];
    entry.status = "running";
    entry.prompt = prompt;
    this.emit("status", entry.id, "running");
    this.beginCodexSessionDiscovery(entry, resume);

    let buffer = "";

    processPty.onData((data: string) => {
      const current = this.sessions.get(entry.id);
      if (!current || current.launchId !== launchId || current.pty !== processPty) {
        return;
      }

      this.emit("output", entry.id, data);

      const lower = data.toLowerCase();
      if (lower.includes("trust") && lower.includes("directory")) {
        log.debug(`${ts()} auto-accepting trust prompt`);
        processPty.write("y\r");
        return;
      }

      if (data.includes("\x1b[2J") || data.includes("\x1b[H\x1b[2J")) {
        buffer = "";
      }

      buffer += data;
      if (buffer.length > 2048) {
        buffer = buffer.slice(-2048);
      }

      const clean = this.stripAnsi(buffer);
      const parsed = this.parsePrompt(clean);
      if (parsed) {
        log.debug(`${ts()} interactive prompt detected (${parsed.options.length} opts)`);
        current.pendingOptions = parsed.options;
        this.emit("approval", entry.id, parsed.contextText, parsed.options);
        buffer = "";
      }

      if (current.idleCompletionTimer) {
        clearTimeout(current.idleCompletionTimer);
        current.idleCompletionTimer = null;
      }
      if (current.discoveryTimer) {
        clearInterval(current.discoveryTimer);
        current.discoveryTimer = null;
      }

      if (Date.now() - current.startedAt > 15_000) {
        current.idleCompletionTimer = setTimeout(() => {
          const latest = this.sessions.get(entry.id);
          if (
            !latest ||
            latest.launchId !== launchId ||
            latest.pty !== processPty ||
            latest.status !== "running"
          ) {
            return;
          }

          log.debug(`${ts()} session ${entry.id} - no PTY output for 15s, marking idle`);
          latest.status = "idle";
          latest.pendingOptions = [];
          latest.pty = null;
          this.emit("status", entry.id, "idle");

          try {
            processPty.kill();
          } catch {
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
        this.sessions.delete(entry.id);
        return;
      }

      if (exitCode === 0) {
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
      this.sessions.delete(entry.id);
    });
  }

  private buildArgs(
    prompt: string,
    modelName: string,
    reasoningEffort: string,
    mode: "full-auto" | "auto-edit" | "suggest",
    resume: boolean,
    codexSessionId?: string | null,
  ): string[] {
    const args: string[] = [];

    if (resume) {
      args.push("exec", "resume");
      if (codexSessionId) {
        args.push(codexSessionId);
      } else {
        args.push("--last");
      }
      args.push("-c", `model="${modelName}"`);
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      if (mode === "full-auto" || mode === "auto-edit") {
        args.push("--full-auto");
      }
      args.push(prompt);
      return args;
    }

    args.push("-c", `model="${modelName}"`);
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    if (mode === "full-auto" || mode === "auto-edit") {
      args.push("--full-auto");
    }

    args.push(prompt);
    return args;
  }

  private parsePrompt(text: string): { contextText: string; options: ParsedOption[] } | null {
    const lastMarker = text.lastIndexOf("\u203a");
    if (lastMarker === -1) {
      return null;
    }

    const region = text.slice(
      Math.max(0, lastMarker - 200),
      Math.min(text.length, lastMarker + 800),
    );

    const options: ParsedOption[] = [];
    const matcher = /(\d+)\.\s+(.+?)(?:\s+\((\w+)\))?\s*$/gm;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(region)) !== null) {
      const expectedNum = options.length + 1;
      if (Number(match[1]) !== expectedNum) {
        options.length = 0;
        if (Number(match[1]) === 1) {
          options.push({
            index: 0,
            label: match[2].trim(),
            shortcutKey: match[3] ?? null,
          });
        }
        continue;
      }

      options.push({
        index: options.length,
        label: match[2].trim(),
        shortcutKey: match[3] ?? null,
      });
    }

    if (options.length < 2) {
      return null;
    }

    const pos = region.search(/\d+\.\s+/);
    const contextText = pos > 0 ? region.slice(0, pos).trim() : region;
    return { contextText, options };
  }

  private stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  }

  private beginCodexSessionDiscovery(entry: SessionEntry, resume: boolean): void {
    if (entry.discoveryTimer) {
      clearInterval(entry.discoveryTimer);
      entry.discoveryTimer = null;
    }

    if (resume && entry.codexSessionId) {
      this.emit("codexSession", entry.id, entry.codexSessionId);
      return;
    }

    const startedAtMs = Date.now();
    let attempts = 0;
    entry.discoveryTimer = setInterval(() => {
      attempts += 1;
      const current = this.sessions.get(entry.id);
      if (!current || current !== entry) {
        if (entry.discoveryTimer) {
          clearInterval(entry.discoveryTimer);
          entry.discoveryTimer = null;
        }
        return;
      }

      const discovered = findCodexSessionIdForProject(entry.projectPath, startedAtMs);
      if (discovered) {
        current.codexSessionId = discovered;
        this.emit("codexSession", current.id, discovered);
        if (current.discoveryTimer) {
          clearInterval(current.discoveryTimer);
          current.discoveryTimer = null;
        }
        return;
      }

      if (attempts >= 20 && current.discoveryTimer) {
        clearInterval(current.discoveryTimer);
        current.discoveryTimer = null;
      }
    }, 1_000);
  }
}
