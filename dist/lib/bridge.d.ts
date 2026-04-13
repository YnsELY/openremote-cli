import { EventEmitter } from "node:events";
import type { AppConfig, InboundMessage, OutboundMessage } from "./types.js";
interface BridgeEvents {
    connected: () => void;
    disconnected: () => void;
    ready: () => void;
    message: (msg: InboundMessage) => void;
}
export declare class Bridge extends EventEmitter {
    private readonly config;
    private readonly machineToken;
    private client;
    private machineChannel;
    private heartbeatTimer;
    private reconnectTimer;
    private reconnectDelay;
    private readonly maxReconnectDelay;
    private shouldReconnect;
    private machineAccessToken;
    private machineAccessTokenExpiresAt;
    private machineState;
    private readonly sessions;
    constructor(config: AppConfig, machineToken: string);
    on<K extends keyof BridgeEvents>(event: K, fn: BridgeEvents[K]): this;
    emit<K extends keyof BridgeEvents>(event: K, ...args: Parameters<BridgeEvents[K]>): boolean;
    connect(): void;
    disconnect(): Promise<void>;
    send(msg: OutboundMessage): void;
    get isConnected(): boolean;
    private openConnection;
    private registerInboundEvent;
    private handleOutboundMessage;
    private getSessionState;
    private bufferOutput;
    private flushOutputBuffer;
    private flushAllOutputs;
    private makeEvent;
    private deriveMachineState;
    private ingest;
    private sendHeartbeat;
    private startHeartbeatLoop;
    private stopHeartbeat;
    private ensureMachineAccessToken;
    private handleDisconnect;
    private scheduleReconnect;
    private clearReconnectTimer;
}
export {};
