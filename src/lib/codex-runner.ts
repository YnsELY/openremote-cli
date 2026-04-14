import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { findCodexSessionIdForProject } from "./codex-session-store.js";
import { log } from "./logger.js";
import type { ProviderRunner, ProviderSessionOptions } from "./provider-runner.js";
import { resolveExecutable } from "./shell.js";
import type { ParsedOption, RunnerEvents, SessionStatus } from "./types.js";

function ts() {
  return `[${new Date().toISOString()}] [runner]`;
}

type CliMode = "default" | "plan";
type StartupPhase = "launching" | "waiting_mode_banner" | "toggling_mode" | "ready" | "failed";

const MODE_HANDSHAKE_TIMEOUT_MS = 8_000;
const IDLE_OUTPUT_TIMEOUT_MS = 15_000;
const MAX_MODE_SWITCH_ATTEMPTS = 2;
const SHIFT_TAB = "\x1b[Z";

interface SessionEntry {
  id: string;
  prompt: string;
  modelName: string;
  reasoningEffort: string;
  projectPath: string;
  approvalMode: "full-auto" | "auto-edit" | "suggest";
  planMode: boolean;
  status: SessionStatus;
  startedAt: number;
  exitCode: number | null;
  apiKey: string;
  pty: pty.IPty | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pendingOptions: ParsedOption[];
  pendingRequestId: string | null;
  idleCompletionTimer: ReturnType<typeof setTimeout> | null;
  launchId: number;
  providerSessionId: string | null;
  discoveryTimer: ReturnType<typeof setInterval> | null;
  awaitingApproval: boolean;
  lastApprovalSignature: string | null;
  requestCounter: number;
  desiredPlanMode: boolean;
  confirmedCliMode: CliMode | null;
  pendingPrompt: string | null;
  startupPhase: StartupPhase;
  modeSwitchAttempts: number;
  modeHandshakeTimer: ReturnType<typeof setTimeout> | null;
  modeFailureStatus: SessionStatus | null;
  terminateOnModeFailure: boolean;
  ptyTracePath: string | null;
  ptyTraceStream: WriteStream | null;
  mirrorWindowOpened: boolean;
  submitTimer: ReturnType<typeof setTimeout> | null;
}

export class CodexRunner extends EventEmitter implements ProviderRunner {
  readonly provider = "codex" as const;
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
      planMode,
      apiKey = "",
      providerSessionId = null,
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
      planMode,
      status: "queued",
      startedAt: Date.now(),
      exitCode: null,
      apiKey,
      pty: null,
      timeout: timer,
      pendingOptions: [],
      pendingRequestId: null,
      idleCompletionTimer: null,
      launchId: 0,
      providerSessionId,
      discoveryTimer: null,
      awaitingApproval: false,
      lastApprovalSignature: null,
      requestCounter: 0,
      desiredPlanMode: planMode,
      confirmedCliMode: null,
      pendingPrompt: null,
      startupPhase: "ready",
      modeSwitchAttempts: 0,
      modeHandshakeTimer: null,
      modeFailureStatus: null,
      terminateOnModeFailure: false,
      ptyTracePath: null,
      ptyTraceStream: null,
      mirrorWindowOpened: false,
      submitTimer: null,
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
      planMode,
      apiKey = "",
      providerSessionId = null,
    } = options;
    const entry: SessionEntry = {
      id: sessionId,
      prompt,
      modelName,
      reasoningEffort,
      projectPath,
      approvalMode,
      planMode,
      status: "idle",
      startedAt: Date.now(),
      exitCode: null,
      apiKey,
      pty: null,
      timeout: null,
      pendingOptions: [],
      pendingRequestId: null,
      idleCompletionTimer: null,
      launchId: 0,
      providerSessionId,
      discoveryTimer: null,
      awaitingApproval: false,
      lastApprovalSignature: null,
      requestCounter: 0,
      desiredPlanMode: planMode,
      confirmedCliMode: null,
      pendingPrompt: null,
      startupPhase: "ready",
      modeSwitchAttempts: 0,
      modeHandshakeTimer: null,
      modeFailureStatus: null,
      terminateOnModeFailure: false,
      ptyTracePath: null,
      ptyTraceStream: null,
      mirrorWindowOpened: false,
      submitTimer: null,
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
    if (!entry || !entry.pty) {
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

    const option = entry.pendingOptions[optionIndex];
    if (!option && optionIndex >= entry.pendingOptions.length) {
      return {
        ok: false,
        error: "Approval could not be resolved because the selected option is invalid.",
      };
    }

    if (entry.idleCompletionTimer) {
      clearTimeout(entry.idleCompletionTimer);
      entry.idleCompletionTimer = null;
    }

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
    entry.pendingRequestId = null;
    entry.awaitingApproval = false;
    entry.lastApprovalSignature = null;
    entry.status = "running";
    this.emit("status", sessionId, "running");
    return { ok: true };
  }

  inputToSession(
    sessionId: string,
    text: string,
    modelName?: string,
    planMode?: boolean,
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

    const previousDesiredPlanMode = entry.desiredPlanMode;

    if (modelName) {
      entry.modelName = modelName;
    }
    if (typeof planMode === "boolean") {
      entry.planMode = planMode;
      entry.desiredPlanMode = planMode;
    }
    if (reasoningEffort) {
      entry.reasoningEffort = reasoningEffort;
    }
    if (approvalMode) {
      entry.approvalMode = approvalMode;
    }

    if (entry.status === "idle") {
      this.launchProcess(entry, text, true);
      return true;
    }

    if (!entry.pty) {
      return false;
    }

    entry.prompt = text;
    const planModeChanged = previousDesiredPlanMode !== entry.desiredPlanMode;
    if (this.modeMatchesTarget(entry.confirmedCliMode, entry.desiredPlanMode)) {
      this.submitPrompt(entry, text, "direct-input");
      return true;
    }

    if (!planModeChanged && !entry.desiredPlanMode && entry.confirmedCliMode === null) {
      this.submitPrompt(entry, text, "direct-input-inferred-default");
      return true;
    }

    this.beginModeHandshake(entry, text, entry.status, false, false);
    return true;
  }

  cancelSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return false;
    }

    entry.status = "cancelled";
    this.emit("status", sessionId, "cancelled");
    this.clearRuntimeTimers(entry);

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

    this.clearRuntimeTimers(entry);
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

    this.closeTrace(entry);
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
    const requiresModeHandshake = entry.desiredPlanMode;
    const args = this.buildArgs(
      prompt,
      entry.modelName,
      entry.reasoningEffort,
      entry.approvalMode,
      resume,
      providerSessionIdOrLast(entry.providerSessionId),
      !requiresModeHandshake,
    );
    log.debug(`${ts()} session ${entry.id} - codex ${args.join(" ")}`);
    log.debug(`${ts()} cwd: ${entry.projectPath}`);
    const isWin = process.platform === "win32";
    const resolvedCodex = isWin ? null : resolveExecutable("codex");
    this.writeTrace(entry, "launch", {
      resume,
      desiredPlanMode: entry.desiredPlanMode,
      includePrompt: !requiresModeHandshake,
      args,
      cwd: entry.projectPath,
      resolvedExecutable: resolvedCodex,
    });

    const shell = isWin ? "cmd.exe" : resolvedCodex ?? "codex";
    const shellArgs = isWin ? ["/c", "codex", ...args] : args;

    if (!isWin && !resolvedCodex) {
      const detail =
        "Failed to launch Codex PTY because the codex binary could not be resolved from the login shell PATH.";
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

    let processPty: pty.IPty;
    try {
      processPty = pty.spawn(shell, shellArgs, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: entry.projectPath,
        env: { ...process.env, OPENAI_API_KEY: entry.apiKey } as Record<string, string>,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail =
        `Failed to launch Codex PTY (shell=${shell}, cwd=${entry.projectPath}). ${message}`;
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
    entry.prompt = prompt;
    entry.confirmedCliMode = null;
    entry.status = "running";
    this.emit("status", entry.id, "running");
    this.beginCodexSessionDiscovery(entry, resume);

    if (requiresModeHandshake) {
      this.beginModeHandshake(entry, prompt, resume ? "idle" : "failed", !resume, true);
    } else {
      entry.pendingPrompt = null;
      entry.startupPhase = "ready";
      entry.modeFailureStatus = null;
      entry.terminateOnModeFailure = false;
    }

    let buffer = "";

    processPty.onData((data: string) => {
      const current = this.sessions.get(entry.id);
      if (!current || current.launchId !== launchId || current.pty !== processPty) {
        return;
      }

      this.emit("output", entry.id, data);
      this.writeTrace(entry, "pty-output", { data });

      const lower = data.toLowerCase();
      if (lower.includes("trust") && lower.includes("directory")) {
        log.debug(`${ts()} auto-accepting trust prompt`);
        this.writeTrace(current, "pty-input", { text: "y", reason: "trust-directory" });
        processPty.write("y\r");
        return;
      }

      if (data.includes("\x1b[2J") || data.includes("\x1b[H\x1b[2J")) {
        buffer = "";
      }

      buffer += data;
      if (buffer.length > 8192) {
        buffer = buffer.slice(-8192);
      }

      const clean = this.stripAnsi(buffer);
      if (
        current.startupPhase === "waiting_mode_banner" &&
        this.detectCliReady(clean)
      ) {
        this.writeTrace(current, "cli-ready", {
          desiredPlanMode: current.desiredPlanMode,
          startupPhase: current.startupPhase,
        });
        current.startupPhase = "toggling_mode";
        this.sendShiftTab(current);
        this.startModeHandshakeTimer(current);
      }

      const detectedMode = this.detectCliMode(clean);
      if (detectedMode) {
        this.writeTrace(current, "mode-banner", { mode: detectedMode });
        this.handleDetectedMode(current, detectedMode);
      }

      const parsed = this.parsePrompt(clean);
      if (parsed) {
        this.raiseApproval(current, parsed);
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

      if (Date.now() - current.startedAt > IDLE_OUTPUT_TIMEOUT_MS) {
        current.idleCompletionTimer = setTimeout(() => {
          const latest = this.sessions.get(entry.id);
          if (
            !latest ||
            latest.launchId !== launchId ||
            latest.pty !== processPty ||
            latest.status !== "running" ||
            latest.awaitingApproval ||
            latest.startupPhase !== "ready"
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
        }, IDLE_OUTPUT_TIMEOUT_MS);
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
      if (current.modeHandshakeTimer) {
        clearTimeout(current.modeHandshakeTimer);
        current.modeHandshakeTimer = null;
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
        current.startupPhase = "ready";
        this.emit("status", entry.id, "idle");
        return;
      }

      if (current.timeout) {
        clearTimeout(current.timeout);
        current.timeout = null;
      }

      current.status = "failed";
      current.startupPhase = "failed";
      this.emit("status", entry.id, "failed");
      this.emit("complete", entry.id, exitCode, duration);
      this.closeTrace(current);
      this.sessions.delete(entry.id);
    });
  }

  private buildArgs(
    prompt: string,
    modelName: string,
    reasoningEffort: string,
    mode: "full-auto" | "auto-edit" | "suggest",
    resume: boolean,
    resumeTarget: string,
    includePrompt: boolean,
  ): string[] {
    const args: string[] = [];

    if (resume) {
      args.push("exec", "resume");
      args.push(resumeTarget);
      args.push("-c", `model="${modelName}"`);
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
      if (mode === "full-auto" || mode === "auto-edit") {
        args.push("--full-auto");
      }
      if (includePrompt && prompt.trim()) {
        args.push(prompt);
      }
      return args;
    }

    args.push("-c", `model="${modelName}"`);
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    if (mode === "full-auto" || mode === "auto-edit") {
      args.push("--full-auto");
    }
    if (includePrompt && prompt.trim()) {
      args.push(prompt);
    }
    return args;
  }

  private beginModeHandshake(
    entry: SessionEntry,
    prompt: string,
    failureStatus: SessionStatus | null,
    terminateOnFailure: boolean,
    waitForInitialBanner: boolean,
  ): void {
    entry.pendingPrompt = prompt;
    entry.startupPhase = waitForInitialBanner ? "waiting_mode_banner" : "toggling_mode";
    entry.modeFailureStatus = failureStatus;
    entry.terminateOnModeFailure = terminateOnFailure;
    entry.modeSwitchAttempts = 0;
    entry.pendingOptions = [];
    entry.pendingRequestId = null;
    entry.awaitingApproval = false;
    entry.lastApprovalSignature = null;

    if (!waitForInitialBanner && entry.pty) {
      this.sendShiftTab(entry);
    }

    this.writeTrace(entry, "mode-handshake-start", {
      prompt,
      fallbackStatus: entry.modeFailureStatus,
      terminateOnFailure: entry.terminateOnModeFailure,
      waitForInitialBanner,
      initialShiftTabSent: Boolean(entry.pty),
      desiredPlanMode: entry.desiredPlanMode,
    });
    this.startModeHandshakeTimer(entry);
  }

  private startModeHandshakeTimer(entry: SessionEntry): void {
    if (entry.modeHandshakeTimer) {
      clearTimeout(entry.modeHandshakeTimer);
    }
    entry.modeHandshakeTimer = setTimeout(() => {
      const current = this.sessions.get(entry.id);
      if (!current || current !== entry) {
        return;
      }
      this.failModeHandshake(
        current,
        "Plan mode could not be confirmed in Codex CLI. No prompt was sent.",
      );
    }, MODE_HANDSHAKE_TIMEOUT_MS);
  }

  private handleDetectedMode(entry: SessionEntry, mode: CliMode): void {
    const previousMode = entry.confirmedCliMode;
    entry.confirmedCliMode = mode;
    this.writeTrace(entry, "mode-detected", {
      mode,
      previousMode,
      startupPhase: entry.startupPhase,
      desiredMode: this.desiredCliMode(entry.desiredPlanMode),
    });

    if (entry.startupPhase === "ready" || entry.startupPhase === "failed") {
      return;
    }

    const desiredMode = this.desiredCliMode(entry.desiredPlanMode);
    if (mode === desiredMode) {
      this.completeModeHandshake(entry);
      return;
    }

    if (
      entry.startupPhase === "toggling_mode" &&
      previousMode === mode
    ) {
      return;
    }

    if (entry.modeSwitchAttempts >= MAX_MODE_SWITCH_ATTEMPTS) {
      this.failModeHandshake(
        entry,
        "Plan mode could not be confirmed in Codex CLI. No prompt was sent.",
      );
      return;
    }

    if (!entry.pty) {
      this.failModeHandshake(
        entry,
        "Plan mode could not be confirmed in Codex CLI because the session closed before the prompt was sent.",
      );
      return;
    }

    entry.startupPhase = "toggling_mode";
    this.sendShiftTab(entry);
    this.startModeHandshakeTimer(entry);
  }

  private completeModeHandshake(entry: SessionEntry): void {
    if (entry.modeHandshakeTimer) {
      clearTimeout(entry.modeHandshakeTimer);
      entry.modeHandshakeTimer = null;
    }

    const prompt = entry.pendingPrompt;
    entry.pendingPrompt = null;
    entry.startupPhase = "ready";
    entry.modeFailureStatus = null;
    entry.terminateOnModeFailure = false;

    if (prompt && entry.pty) {
      this.submitPrompt(entry, prompt, "mode-handshake-complete");
    }
  }

  private failModeHandshake(entry: SessionEntry, message: string): void {
    const finalMessage = entry.ptyTracePath ? `${message} PTY trace: ${entry.ptyTracePath}` : message;
    log.debug(`${ts()} session ${entry.id} - ${finalMessage}`);
    if (entry.modeHandshakeTimer) {
      clearTimeout(entry.modeHandshakeTimer);
      entry.modeHandshakeTimer = null;
    }

    entry.pendingPrompt = null;
    entry.startupPhase = "failed";
    entry.pendingOptions = [];
    entry.pendingRequestId = null;
    entry.awaitingApproval = false;
    entry.lastApprovalSignature = null;
    this.writeTrace(entry, "mode-handshake-failed", {
      message,
      fallbackStatus: entry.modeFailureStatus,
      terminate: entry.terminateOnModeFailure,
    });
    this.emit("error", entry.id, finalMessage);

    const fallbackStatus = entry.modeFailureStatus;
    const terminate = entry.terminateOnModeFailure;
    const processPty = entry.pty;
    entry.pty = null;
    entry.modeFailureStatus = null;
    entry.terminateOnModeFailure = false;

    if (processPty) {
      try {
        processPty.kill();
      } catch {
        // Process may already have exited.
      }
    }

    if (terminate) {
      if (entry.timeout) {
        clearTimeout(entry.timeout);
        entry.timeout = null;
      }
      entry.status = "failed";
      this.emit("status", entry.id, "failed");
      this.emit("complete", entry.id, 1, Date.now() - entry.startedAt);
      this.closeTrace(entry);
      this.sessions.delete(entry.id);
      return;
    }

    if (fallbackStatus && entry.status !== fallbackStatus) {
      entry.status = fallbackStatus;
      this.emit("status", entry.id, fallbackStatus);
      if (fallbackStatus === "idle") {
        entry.startupPhase = "ready";
      }
    }
  }

  private sendShiftTab(entry: SessionEntry): void {
    if (!entry.pty) {
      return;
    }
    entry.modeSwitchAttempts += 1;
    log.debug(`${ts()} session ${entry.id} - sending Shift+Tab attempt ${entry.modeSwitchAttempts}`);
    this.writeTrace(entry, "pty-input", {
      text: SHIFT_TAB,
      label: "Shift+Tab",
      attempt: entry.modeSwitchAttempts,
    });
    entry.pty.write(SHIFT_TAB);
  }

  private desiredCliMode(planMode: boolean): CliMode {
    return planMode ? "plan" : "default";
  }

  private modeMatchesTarget(mode: CliMode | null, planMode: boolean): boolean {
    return mode === this.desiredCliMode(planMode);
  }

  private detectCliMode(text: string): CliMode | null {
    const match = text.match(/\b(plan|default)\s+mode\s*\(shift\+tab to cycle\)/i);
    if (!match) {
      return null;
    }
    return match[1].toLowerCase() === "plan" ? "plan" : "default";
  }

  private detectCliReady(text: string): boolean {
    return (
      /OpenAI Codex/i.test(text) &&
      /model:\s+/i.test(text) &&
      /directory:\s+/i.test(text) &&
      /(^|\n)\s*[›>]\s+/m.test(text)
    );
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

  private raiseApproval(
    entry: SessionEntry,
    parsed: { contextText: string; options: ParsedOption[] },
  ): void {
    const { title, message } = this.extractApprovalTextParts(parsed.contextText);
    const signature = `${title ?? ""}::${message}::${parsed.options
      .map((option) => `${option.index}:${option.label}:${option.shortcutKey ?? ""}`)
      .join("|")}`;

    if (entry.awaitingApproval && entry.lastApprovalSignature === signature) {
      return;
    }

    log.debug(`${ts()} interactive prompt detected (${parsed.options.length} opts)`);
    entry.requestCounter += 1;
    entry.pendingOptions = parsed.options;
    entry.pendingRequestId = `${entry.id}-approval-${entry.requestCounter}`;
    entry.awaitingApproval = true;
    entry.lastApprovalSignature = signature;
    entry.status = "busy";
    this.emit("status", entry.id, "busy");
    this.emit(
      "approval",
      entry.id,
      entry.pendingRequestId,
      title,
      message,
      parsed.options,
    );
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
      message: contextText.trim() || "Approval required",
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

  private beginCodexSessionDiscovery(entry: SessionEntry, resume: boolean): void {
    if (entry.discoveryTimer) {
      clearInterval(entry.discoveryTimer);
      entry.discoveryTimer = null;
    }

    if (resume && entry.providerSessionId) {
      this.emit("providerSession", entry.id, entry.providerSessionId);
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
        current.providerSessionId = discovered;
        this.emit("providerSession", current.id, discovered);
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

  private clearRuntimeTimers(entry: SessionEntry): void {
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
    if (entry.modeHandshakeTimer) {
      clearTimeout(entry.modeHandshakeTimer);
      entry.modeHandshakeTimer = null;
    }
    if (entry.submitTimer) {
      clearTimeout(entry.submitTimer);
      entry.submitTimer = null;
    }
  }

  private ensureTrace(entry: SessionEntry): void {
    if (entry.ptyTraceStream && entry.ptyTracePath) {
      return;
    }
    const logsDir = path.join(homedir(), ".openremote", "pty-logs");
    mkdirSync(logsDir, { recursive: true });
    const tracePath = path.join(logsDir, `${entry.id}-${Date.now()}.jsonl`);
    entry.ptyTracePath = tracePath;
    entry.ptyTraceStream = createWriteStream(tracePath, { flags: "a" });
    this.writeTrace(entry, "trace-start", {
      sessionId: entry.id,
      projectPath: entry.projectPath,
      tracePath,
    });
    this.emit("sessionLog", entry.id, tracePath);
    log.debug(`${ts()} session ${entry.id} - PTY trace ${tracePath}`);
    this.openMirrorWindow(entry);
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

  private submitPrompt(entry: SessionEntry, prompt: string, reason: string): void {
    if (!entry.pty) {
      return;
    }
    if (entry.submitTimer) {
      clearTimeout(entry.submitTimer);
      entry.submitTimer = null;
    }

    this.writeTrace(entry, "pty-input", { text: prompt, reason, phase: "insert" });
    entry.pty.write(prompt);
    entry.submitTimer = setTimeout(() => {
      const current = this.sessions.get(entry.id);
      if (!current || current !== entry || !current.pty) {
        return;
      }
      this.writeTrace(current, "pty-input", { text: "\\r", reason, phase: "submit" });
      current.pty.write("\r");
      current.submitTimer = null;
    }, 120);
  }

  private openMirrorWindow(entry: SessionEntry): void {
    if (entry.mirrorWindowOpened || process.platform !== "win32" || !entry.ptyTracePath) {
      return;
    }

    const enabled = process.env.OPENREMOTE_PTY_WINDOW;
    if (enabled !== "1" && enabled?.toLowerCase() !== "true") {
      return;
    }

    const viewerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "tools",
      "pty-trace-viewer.js",
    );

    try {
      spawn(process.execPath, [viewerPath, entry.ptyTracePath, entry.id], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
      entry.mirrorWindowOpened = true;
      this.writeTrace(entry, "mirror-window-opened", {
        viewerPath,
        tracePath: entry.ptyTracePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeTrace(entry, "mirror-window-error", { message });
      log.debug(`${ts()} session ${entry.id} - failed to open PTY mirror window: ${message}`);
    }
  }
}

function providerSessionIdOrLast(providerSessionId?: string | null): string {
  return providerSessionId || "--last";
}
