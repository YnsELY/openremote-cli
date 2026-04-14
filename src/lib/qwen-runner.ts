import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import { log } from "./logger.js";
import type { ProviderRunner, ProviderSessionOptions } from "./provider-runner.js";
import { buildShellCommand, getShellLaunch } from "./shell.js";
import type { ParsedOption, RunnerEvents, SessionStatus } from "./types.js";

function ts() {
  return `[${new Date().toISOString()}] [qwen-runner]`;
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
  pty: pty.IPty | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pendingOptions: ParsedOption[];
  pendingRequestId: string | null;
  idleCompletionTimer: ReturnType<typeof setTimeout> | null;
  launchId: number;
  providerSessionId: string;
  awaitingApproval: boolean;
  lastApprovalSignature: string | null;
  requestCounter: number;
  ptyTracePath: string | null;
  ptyTraceStream: WriteStream | null;
}

export class QwenRunner extends EventEmitter implements ProviderRunner {
  readonly provider = "qwen" as const;
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

  startSession(options: ProviderSessionOptions): void {
    const {
      sessionId,
      projectPath,
      prompt,
      modelName,
      reasoningEffort,
      approvalMode,
      providerSessionId,
      timeoutMs = 0,
    } = options;

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
    };

    this.ensureTrace(entry);
    this.sessions.set(sessionId, entry);
    this.launchProcess(entry, prompt, false);
  }

  resumeSession(options: ProviderSessionOptions): void {
    const {
      sessionId,
      projectPath,
      prompt,
      modelName,
      reasoningEffort,
      approvalMode,
      providerSessionId,
    } = options;

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
    };

    this.ensureTrace(entry);
    this.sessions.set(sessionId, entry);
    this.launchProcess(entry, prompt, true);
  }

  respondToSession(
    sessionId: string,
    requestId: string,
    optionIndex: number,
  ): { ok: boolean; error?: string } {
    const entry = this.sessions.get(sessionId);
    log.debug(
      `${ts()} respondToSession: sessionId=${sessionId}, requestId=${requestId}, optionIndex=${optionIndex}`,
    );
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
      let input: string;

      if (normalizedShortcut === "esc") {
        input = "\x1b";
      } else if (normalizedShortcut === "enter") {
        input = "\r";
      } else if (
        normalizedShortcut === "y" ||
        normalizedShortcut === "n" ||
        normalizedShortcut === "yes" ||
        normalizedShortcut === "no"
      ) {
        input = `${normalizedShortcut.startsWith("y") ? "y" : "n"}\r`;
      } else {
        input = option.shortcutKey;
      }

      log.debug(`${ts()} respondToSession: sending shortcut input: ${JSON.stringify(input)}`);
      this.writeTrace(entry, "pty-input", {
        text: input,
        optionIndex,
        reason: "approval-shortcut",
      });
      entry.pty.write(input);
    } else if (entry.pendingOptions.length > 0) {
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
    } else {
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

  inputToSession(
    sessionId: string,
    text: string,
    modelName?: string,
    _planMode?: boolean,
    reasoningEffort?: string,
    approvalMode?: "full-auto" | "auto-edit" | "suggest",
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

    if (!entry.pty) {
      const duration = Date.now() - entry.startedAt;
      this.emit("complete", sessionId, 130, duration);
      this.closeTrace(entry);
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
      } catch {
        // Process may already have exited.
      }
    }

    this.emit("complete", sessionId, 0, duration);
    this.closeTrace(entry);
    this.sessions.delete(sessionId);
    return true;
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.cancelSession(id);
    }
  }

  private launchProcess(entry: SessionEntry, prompt: string, resume: boolean): void {
    const args = this.buildArgs(prompt, entry.approvalMode, resume, entry.providerSessionId);
    log.debug(`${ts()} session ${entry.id} - qwen ${args.join(" ")}`);
    log.debug(`${ts()} cwd: ${entry.projectPath}`);
    this.writeTrace(entry, "launch", {
      resume,
      args,
      cwd: entry.projectPath,
      providerSessionId: entry.providerSessionId,
    });

    const shellLaunch = getShellLaunch();
    const shellCommand =
      process.platform === "win32"
        ? ["qwen", ...args].join(" ")
        : buildShellCommand("qwen", args);
    const shell = shellLaunch.shell;
    const shellArgs = shellLaunch.argsForCommand(shellCommand);

    const processPty = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: entry.projectPath,
      env: { ...process.env } as Record<string, string>,
    });

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

    let buffer = "";

    processPty.onData((data: string) => {
      const current = this.sessions.get(entry.id);
      if (!current || current.launchId !== launchId || current.pty !== processPty) {
        return;
      }

      this.emit("output", entry.id, data);
      this.writeTrace(current, "pty-output", { data });

      if (data.includes("\x1b[2J") || data.includes("\x1b[H\x1b[2J")) {
        buffer = "";
      }

      buffer += data;
      if (buffer.length > 8192) {
        buffer = buffer.slice(-8192);
      }

      const clean = this.stripAnsi(buffer);
      const parsed = this.parsePrompt(clean);
      if (parsed) {
        this.raiseApproval(current, parsed.contextText, parsed.options);
        buffer = "";
      } else {
        const genericApprovalMessage = this.detectGenericApproval(clean);
        if (genericApprovalMessage) {
          this.raiseApproval(current, genericApprovalMessage, [
            { index: 0, label: "Accept", shortcutKey: "y" },
            { index: 1, label: "Reject", shortcutKey: "n" },
          ]);
          buffer = "";
        }
      }

      if (current.idleCompletionTimer) {
        clearTimeout(current.idleCompletionTimer);
        current.idleCompletionTimer = null;
      }

      if (!current.awaitingApproval && Date.now() - current.startedAt > 15_000) {
        current.idleCompletionTimer = setTimeout(() => {
          const latest = this.sessions.get(entry.id);
          if (
            !latest ||
            latest.launchId !== launchId ||
            latest.pty !== processPty ||
            latest.status !== "running" ||
            latest.awaitingApproval
          ) {
            return;
          }

          log.debug(`${ts()} session ${entry.id} - no PTY output for 15s, marking idle`);
          latest.status = "idle";
          latest.pendingOptions = [];
          latest.pendingRequestId = null;
          latest.awaitingApproval = false;
          latest.lastApprovalSignature = null;
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

  private buildArgs(
    prompt: string,
    mode: "full-auto" | "auto-edit" | "suggest",
    resume: boolean,
    providerSessionId: string,
  ): string[] {
    const args: string[] = ["--approval-mode", this.mapApprovalMode(mode)];

    if (resume) {
      args.push("--resume", providerSessionId);
    } else {
      args.push("--session-id", providerSessionId);
    }

    args.push("-i", prompt);
    return args;
  }

  private mapApprovalMode(mode: "full-auto" | "auto-edit" | "suggest"): string {
    if (mode === "full-auto") {
      return "yolo";
    }
    if (mode === "auto-edit") {
      return "auto-edit";
    }
    return "default";
  }

  private parsePrompt(text: string): { contextText: string; options: ParsedOption[] } | null {
    const lines = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .slice(-80)
      .map((line) => line.trimEnd());
    const optionMatcher =
      /^(?:\s*(?:\u203a|\u276f|>|->|\*)\s*)?(\d+)[.)]\s+(.+?)(?:\s+\(([\w-]+)\))?\s*$/;
    const hasCursorPrefix = (line: string) =>
      /^\s*(?:\u203a|\u276f|>|->|\*)\s*/.test(line);
    const isDescriptionLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || optionMatcher.test(trimmed)) {
        return false;
      }
      return (
        /^\s{2,}\S/.test(line) ||
        /^[a-z]/.test(trimmed) ||
        /\b(recommended|default|faster|safer|impact|tradeoff)\b/i.test(trimmed)
      );
    };
    let blockStart = -1;
    let blockHasCursor = false;
    let blockOptions: ParsedOption[] = [];
    let bestStart = -1;
    let bestEnd = -1;
    let bestHasCursor = false;
    let bestOptions: ParsedOption[] = [];
    const commitBlock = (endExclusive: number) => {
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
    const contextLines: string[] = [];
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
    const looksInteractive =
      bestHasCursor ||
      bestOptions.some((option) => option.shortcutKey) ||
      /[?]\s*$/.test(lastContextLine) ||
      /\b(recommended|select one|choose one|pick one|press enter to submit|esc to cancel|answer the following|question)\b/i.test(
        `${contextText}\n${region}`,
      ) ||
      /\b(choose|pick|select|which|prefer|option|recommended|continue|confirm|allow|approve|answer|respond|question|what should i|would you like|how should i|autoriser|choisir|quelle option|quel choix|continuer|confirmer|repondre|r??pondre)\b/i.test(
        `${contextText}\n${region}`,
      );
    if (!looksInteractive) {
      return null;
    }
    return {
      contextText: contextText || region,
      options: bestOptions,
    };
  }

  private detectGenericApproval(text: string): string | null {
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
      .map((line) => line.trim())
      .filter(Boolean);
    const relevantLines = lines.filter(
      (line) =>
        !/waiting\s+for/i.test(line) &&
        !/thinking/i.test(line) &&
        line.length > 3,
    );

    const contextLine =
      relevantLines[relevantLines.length - 1] ??
      lines[lines.length - 1] ??
      "Qwen requires confirmation";

    return contextLine.length > 180 ? `${contextLine.slice(0, 177)}...` : contextLine;
  }

  private raiseApproval(
    entry: SessionEntry,
    message: string,
    options: ParsedOption[],
  ): void {
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
    this.emit(
      "approval",
      entry.id,
      entry.pendingRequestId,
      textParts.title,
      textParts.message,
      options,
    );
  }

  private respondToDetectedApproval(entry: SessionEntry, optionIndex: number): void {
    if (!entry.pty) {
      return;
    }

    const option = entry.pendingOptions[optionIndex];
    if (option?.shortcutKey) {
      const normalizedShortcut = option.shortcutKey.trim().toLowerCase();
      let input: string;

      if (normalizedShortcut === "esc") {
        input = "\x1b";
      } else if (normalizedShortcut === "enter") {
        input = "\r";
      } else if (
        normalizedShortcut === "y" ||
        normalizedShortcut === "n" ||
        normalizedShortcut === "yes" ||
        normalizedShortcut === "no"
      ) {
        input = `${normalizedShortcut.startsWith("y") ? "y" : "n"}\r`;
      } else {
        input = option.shortcutKey;
      }

      entry.pty.write(input);
      this.writeTrace(entry, "pty-input", {
        text: input,
        optionIndex,
        reason: "auto-approval-shortcut",
      });
    } else if (entry.pendingOptions.length > 0) {
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
    } else {
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

  private extractApprovalTextParts(
    contextText: string,
  ): { title: string | null; message: string } {
    const lines = contextText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length >= 2 && lines[0].length <= 80) {
      return {
        title: lines[0],
        message: lines.slice(1).join("\n"),
      };
    }

    return {
      title: null,
      message: contextText.trim() || "Qwen requires confirmation",
    };
  }

  private stripAnsi(value: string): string {
    return value
      .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
      .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r(?!\n)/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .replace(/\u001b/g, "");
  }

  private ensureTrace(entry: SessionEntry): void {
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

  private writeTrace(entry: SessionEntry, event: string, payload: Record<string, unknown>): void {
    if (!entry.ptyTraceStream) {
      return;
    }
    entry.ptyTraceStream.write(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...payload,
      })}\n`,
    );
  }

  private closeTrace(entry: SessionEntry): void {
    if (!entry.ptyTraceStream) {
      return;
    }
    this.writeTrace(entry, "trace-end", { sessionId: entry.id, status: entry.status });
    entry.ptyTraceStream.end();
    entry.ptyTraceStream = null;
  }
}

