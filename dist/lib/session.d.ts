import { Bridge } from "./bridge.js";
import type { InboundMessage } from "./types.js";
/**
 * Manages a single Codex session at a time.
 * Receives commands from the bridge, delegates to CodexRunner,
 * and streams results back through the bridge.
 */
export declare class SessionManager {
    private readonly bridge;
    private readonly apiKey;
    private readonly runner;
    private activeSessionId;
    constructor(bridge: Bridge, apiKey: string);
    handleMessage(msg: InboundMessage): void;
    shutdown(): void;
    get busy(): boolean;
    private handleStart;
    private handleCancel;
    private handleRespond;
    private handleInput;
    private handleFinish;
    private wireRunnerEvents;
}
