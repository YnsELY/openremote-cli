import { EventEmitter } from "node:events";
import type { ProviderRunner, ProviderSessionOptions } from "./provider-runner.js";
import type { RunnerEvents } from "./types.js";
export declare class QwenRunner extends EventEmitter implements ProviderRunner {
    readonly provider: "qwen";
    private sessions;
    on<K extends keyof RunnerEvents>(event: K, fn: RunnerEvents[K]): this;
    emit<K extends keyof RunnerEvents>(event: K, ...args: Parameters<RunnerEvents[K]>): boolean;
    startSession(options: ProviderSessionOptions): void;
    resumeSession(options: ProviderSessionOptions): void;
    respondToSession(sessionId: string, requestId: string, optionIndex: number): {
        ok: boolean;
        error?: string;
    };
    inputToSession(sessionId: string, text: string, modelName?: string, _planMode?: boolean, reasoningEffort?: string, approvalMode?: "full-auto" | "auto-edit" | "suggest", _attachments?: string[]): boolean;
    cancelSession(sessionId: string): boolean;
    finishSession(sessionId: string): boolean;
    killAll(): void;
    private launchProcess;
    private buildArgs;
    private mapApprovalMode;
    private parsePrompt;
    private detectGenericApproval;
    private raiseApproval;
    private respondToDetectedApproval;
    private extractApprovalTextParts;
    private stripAnsi;
    private ensureTrace;
    private writeTrace;
    private closeTrace;
}
