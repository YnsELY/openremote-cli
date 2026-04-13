import { EventEmitter } from "node:events";
import type { RunnerEvents } from "./types.js";
export declare class CodexRunner extends EventEmitter {
    private sessions;
    on<K extends keyof RunnerEvents>(event: K, fn: RunnerEvents[K]): this;
    emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): boolean;
    startSession(sessionId: string, projectPath: string, prompt: string, modelName: string, reasoningEffort: string, approvalMode: "full-auto" | "auto-edit" | "suggest", apiKey: string, codexSessionId?: string | null, timeoutMs?: number): void;
    resumeSession(sessionId: string, projectPath: string, prompt: string, modelName: string, reasoningEffort: string, approvalMode: "full-auto" | "auto-edit" | "suggest", apiKey: string, codexSessionId?: string | null): void;
    respondToSession(sessionId: string, optionIndex: number): boolean;
    inputToSession(sessionId: string, text: string, modelName?: string, reasoningEffort?: string): boolean;
    cancelSession(sessionId: string): boolean;
    finishSession(sessionId: string): boolean;
    hasActiveSession(): boolean;
    getActiveSessionId(): string | null;
    killAll(): void;
    private launchProcess;
    private buildArgs;
    private parsePrompt;
    private stripAnsi;
    private beginCodexSessionDiscovery;
}
