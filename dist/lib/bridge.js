import { EventEmitter } from "node:events";
import { createClient, } from "@supabase/supabase-js";
import { log } from "./logger.js";
import { deriveReadableBlocksFromChunk, makeReadableApprovalBlock, makeReadableErrorBlock, makeReadableStatusBlock, } from "./readable-output.js";
const OUTPUT_FLUSH_MS = 250;
const OUTPUT_MAX_BYTES = 8 * 1024;
const HEARTBEAT_MS = 30_000;
const OFFLINE_GRACE_MS = 90_000;
function nowIso() {
    return new Date().toISOString();
}
function nextTick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
function sessionTopic(sessionId) {
    return `session:${sessionId}`;
}
function machineTopic(machineId) {
    return `machine:${machineId}`;
}
export class Bridge extends EventEmitter {
    config;
    machineToken;
    supportedProviders;
    client = null;
    machineChannel = null;
    heartbeatTimer = null;
    reconnectTimer = null;
    reconnectDelay = 1000;
    maxReconnectDelay = 30_000;
    shouldReconnect = true;
    machineAccessToken = null;
    machineAccessTokenExpiresAt = 0;
    machineState = "idle";
    sessions = new Map();
    constructor(config, machineToken, supportedProviders) {
        super();
        this.config = config;
        this.machineToken = machineToken;
        this.supportedProviders = supportedProviders;
    }
    on(event, fn) {
        return super.on(event, fn);
    }
    emit(event, ...args) {
        return super.emit(event, ...args);
    }
    connect() {
        this.shouldReconnect = true;
        void this.openConnection();
    }
    async disconnect() {
        this.shouldReconnect = false;
        this.clearReconnectTimer();
        this.stopHeartbeat();
        await this.flushAllOutputs();
        try {
            await this.sendHeartbeat("offline");
        }
        catch {
            // Ignore disconnect failures.
        }
        if (this.machineChannel && this.client) {
            await this.client.removeChannel(this.machineChannel);
        }
        this.machineChannel = null;
        this.client = null;
        this.machineAccessToken = null;
        this.machineAccessTokenExpiresAt = 0;
    }
    send(msg) {
        void this.handleOutboundMessage(msg).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            log.debug(`Failed to send bridge message: ${message}`);
        });
    }
    get isConnected() {
        return this.machineChannel?.state === "joined";
    }
    registerSessionProvider(sessionId, provider) {
        this.getSessionState(sessionId).provider = provider;
    }
    async openConnection() {
        try {
            const accessToken = await this.ensureMachineAccessToken();
            this.client = createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                    detectSessionInUrl: false,
                },
            });
            await this.client.realtime.setAuth(accessToken);
            this.machineChannel = this.client.channel(machineTopic(this.config.machineId), {
                config: {
                    private: false,
                    broadcast: { ack: true, self: false },
                },
            });
            this.registerInboundEvent("session:start");
            this.registerInboundEvent("session:cancel");
            this.registerInboundEvent("session:respond");
            this.registerInboundEvent("session:input");
            this.registerInboundEvent("session:finish");
            const subscribed = await new Promise((resolve) => {
                this.machineChannel.subscribe((status) => {
                    if (status === "SUBSCRIBED") {
                        resolve(true);
                        return;
                    }
                    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                        resolve(false);
                    }
                });
            });
            if (!subscribed) {
                throw new Error("Could not subscribe to machine channel");
            }
            this.reconnectDelay = 1000;
            this.emit("connected");
            await this.sendHeartbeat("idle");
            this.startHeartbeatLoop();
            this.emit("ready");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.setDashboard({
                machineStatus: "offline",
                sessionDetail: "Retrying connection",
            });
            log.infoBar("Couldn't connect. Retrying automatically.", "danger");
            log.card("Couldn't connect", [message, "Check your network and retry."], "danger");
            this.scheduleReconnect();
        }
    }
    registerInboundEvent(event) {
        this.machineChannel?.on("broadcast", { event }, ({ payload }) => {
            this.emit("message", {
                type: event,
                payload: payload,
            });
        });
    }
    async handleOutboundMessage(msg) {
        if (msg.type === "machine:offline") {
            await this.disconnect();
            return;
        }
        const sessionId = "sessionId" in msg.payload ? msg.payload.sessionId : null;
        if (sessionId && msg.type !== "session:output") {
            await this.flushOutputBuffer(sessionId, true);
        }
        switch (msg.type) {
            case "session:output":
                this.bufferOutput(msg.payload.sessionId, msg.payload.data, msg.payload.timestamp);
                return;
            case "session:block": {
                const state = this.getSessionState(msg.payload.sessionId);
                await this.ingest(msg.payload.sessionId, {
                    readableBlocks: [
                        {
                            ...msg.payload.block,
                            seq: typeof msg.payload.block.seq === "number"
                                ? msg.payload.block.seq
                                : state.readableSeq++,
                            occurredAt: msg.payload.block.occurredAt ?? nowIso(),
                        },
                    ],
                });
                return;
            }
            case "session:status":
                this.getSessionState(msg.payload.sessionId).lastStatus = msg.payload.status;
                this.machineState = this.recomputeMachineState();
                {
                    const state = this.getSessionState(msg.payload.sessionId);
                    const readableBlock = makeReadableStatusBlock(state.readableSeq++, msg.payload.status, nowIso());
                    await this.ingest(msg.payload.sessionId, {
                        events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
                        readableBlocks: [readableBlock],
                        sessionPatch: { status: msg.payload.status },
                        machineState: this.machineState,
                    });
                }
                return;
            case "session:approval":
                {
                    const state = this.getSessionState(msg.payload.sessionId);
                    const readableBlock = makeReadableApprovalBlock(state.readableSeq++, msg.payload.message, nowIso());
                    await this.ingest(msg.payload.sessionId, {
                        events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
                        readableBlocks: [readableBlock],
                    });
                }
                return;
            case "session:error":
                {
                    const state = this.getSessionState(msg.payload.sessionId);
                    const readableBlock = makeReadableErrorBlock(state.readableSeq++, msg.payload.error, nowIso());
                    await this.ingest(msg.payload.sessionId, {
                        events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
                        readableBlocks: [readableBlock],
                    });
                }
                return;
            case "session:busy":
                {
                    const state = this.getSessionState(msg.payload.sessionId);
                    state.lastStatus = "busy";
                    this.machineState = this.recomputeMachineState();
                    const occurredAt = nowIso();
                    const readableBlock = makeReadableStatusBlock(state.readableSeq++, "busy", occurredAt, "Machine occupee");
                    await this.ingest(msg.payload.sessionId, {
                        events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
                        readableBlocks: [readableBlock],
                        sessionPatch: {
                            status: "busy",
                            completedAt: occurredAt,
                        },
                        machineState: this.machineState,
                    });
                }
                return;
            case "session:meta":
                await this.ingest(msg.payload.sessionId, {
                    sessionPatch: {
                        providerSessionId: msg.payload.providerSessionId,
                    },
                });
                return;
            case "session:complete": {
                const state = this.getSessionState(msg.payload.sessionId);
                const finalStatus = state.lastStatus ?? (msg.payload.exitCode === 0 ? "completed" : "failed");
                state.lastStatus = finalStatus;
                this.machineState = this.recomputeMachineState();
                const occurredAt = nowIso();
                const readableBlock = makeReadableStatusBlock(state.readableSeq++, finalStatus, occurredAt, `exit=${msg.payload.exitCode}, duration=${msg.payload.duration}ms`);
                await this.ingest(msg.payload.sessionId, {
                    events: [this.makeEvent(msg.type, msg.payload.sessionId, msg.payload)],
                    readableBlocks: [readableBlock],
                    sessionPatch: {
                        status: finalStatus,
                        exitCode: msg.payload.exitCode,
                        durationMs: msg.payload.duration,
                        completedAt: occurredAt,
                    },
                    machineState: this.machineState,
                });
                this.sessions.delete(msg.payload.sessionId);
                this.machineState = this.recomputeMachineState();
                return;
            }
            default:
                return;
        }
    }
    getSessionState(sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing)
            return existing;
        const created = {
            provider: null,
            eventSeq: 1,
            outputSeq: 1,
            readableSeq: 1,
            readableRemainder: "",
            lastStatus: null,
            output: {
                text: "",
                byteCount: 0,
                timer: null,
                lastTimestamp: Date.now(),
            },
        };
        this.sessions.set(sessionId, created);
        return created;
    }
    bufferOutput(sessionId, chunk, timestamp) {
        const state = this.getSessionState(sessionId);
        state.output.text += chunk;
        state.output.byteCount += Buffer.byteLength(chunk, "utf-8");
        state.output.lastTimestamp = timestamp;
        if (state.output.byteCount >= OUTPUT_MAX_BYTES) {
            void this.flushOutputBuffer(sessionId).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                log.debug(`Failed to flush output buffer: ${message}`);
            });
            return;
        }
        if (!state.output.timer) {
            state.output.timer = setTimeout(() => {
                void this.flushOutputBuffer(sessionId).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    log.debug(`Failed to flush output buffer: ${message}`);
                });
            }, OUTPUT_FLUSH_MS);
        }
    }
    async flushOutputBuffer(sessionId, final = false) {
        const state = this.sessions.get(sessionId);
        if (!state)
            return;
        if (!state.output.text && (!final || !state.readableRemainder))
            return;
        if (state.output.timer) {
            clearTimeout(state.output.timer);
            state.output.timer = null;
        }
        const occurredAt = new Date(state.output.lastTimestamp || Date.now()).toISOString();
        const outputText = state.output.text;
        const outputByteCount = state.output.byteCount;
        state.output.text = "";
        state.output.byteCount = 0;
        const { blocks: readableBlocks, remainder } = deriveReadableBlocksFromChunk(`${state.readableRemainder}${outputText}`, state.readableSeq, occurredAt, { final });
        const shouldDeriveReadableBlocks = state.provider !== "codex" && state.provider !== "claude";
        state.readableRemainder = shouldDeriveReadableBlocks ? remainder : "";
        if (shouldDeriveReadableBlocks) {
            state.readableSeq += readableBlocks.length;
        }
        const outputSegments = outputText.length > 0
            ? [
                {
                    seq: state.outputSeq++,
                    text: outputText,
                    byteCount: outputByteCount,
                    occurredAt,
                },
            ]
            : [];
        await this.ingest(sessionId, {
            outputSegments,
            readableBlocks: shouldDeriveReadableBlocks ? readableBlocks : [],
        });
    }
    async flushAllOutputs() {
        for (const sessionId of this.sessions.keys()) {
            await this.flushOutputBuffer(sessionId, true);
        }
    }
    makeEvent(eventType, sessionId, payload) {
        const state = this.getSessionState(sessionId);
        return {
            seq: state.eventSeq++,
            eventType,
            payload,
            occurredAt: nowIso(),
        };
    }
    recomputeMachineState() {
        for (const state of this.sessions.values()) {
            if (state.lastStatus === "queued" ||
                state.lastStatus === "running" ||
                state.lastStatus === "busy") {
                return "busy";
            }
        }
        return "idle";
    }
    async ingest(sessionId, payload) {
        const accessToken = await this.ensureMachineAccessToken();
        const body = JSON.stringify({
            sessionId,
            events: payload.events ?? [],
            outputSegments: payload.outputSegments ?? [],
            readableBlocks: payload.readableBlocks ?? [],
            sessionPatch: payload.sessionPatch,
            machineState: payload.machineState,
        });
        const response = await fetch(`${this.config.supabaseUrl}/functions/v1/session-ingest`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
                apikey: this.config.supabaseAnonKey,
            },
            body,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`session-ingest failed (${response.status}): ${text}`);
        }
    }
    async sendHeartbeat(state) {
        const accessToken = await this.ensureMachineAccessToken();
        const response = await fetch(`${this.config.supabaseUrl}/functions/v1/machine-heartbeat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
                apikey: this.config.supabaseAnonKey,
            },
            body: JSON.stringify({
                availabilityState: state ?? this.machineState,
                heartbeatGraceMs: OFFLINE_GRACE_MS,
                cliVersion: this.config.cliVersion,
                supportedProviders: this.supportedProviders,
            }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`machine-heartbeat failed (${response.status}): ${text}`);
        }
    }
    startHeartbeatLoop() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            void this.sendHeartbeat().catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                log.debug(`Heartbeat failed: ${message}`);
                this.handleDisconnect();
            });
        }, HEARTBEAT_MS);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    async ensureMachineAccessToken() {
        const refreshBeforeMs = 60_000;
        if (this.machineAccessToken &&
            Date.now() + refreshBeforeMs < this.machineAccessTokenExpiresAt) {
            return this.machineAccessToken;
        }
        // Try to use the machine token (stored auth token) to get a session
        const response = await fetch(`${this.config.supabaseUrl}/functions/v1/machine-session`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.machineToken}`,
                apikey: this.config.supabaseAnonKey,
            },
            body: JSON.stringify({
                machineId: this.config.machineId,
                cliVersion: this.config.cliVersion,
            }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`machine-session failed (${response.status}): ${text}`);
        }
        const data = (await response.json());
        this.machineAccessToken = data.accessToken;
        this.machineAccessTokenExpiresAt = new Date(data.expiresAt).getTime();
        if (this.client) {
            await this.client.realtime.setAuth(this.machineAccessToken);
        }
        return this.machineAccessToken;
    }
    handleDisconnect() {
        if (!this.shouldReconnect)
            return;
        this.stopHeartbeat();
        this.emit("disconnected");
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (!this.shouldReconnect || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.machineChannel && this.client) {
                await this.client.removeChannel(this.machineChannel);
            }
            this.machineChannel = null;
            this.client = null;
            this.machineAccessToken = null;
            this.machineAccessTokenExpiresAt = 0;
            await nextTick();
            void this.openConnection();
        }, this.reconnectDelay);
        log.status(`Reconnecting in ${(this.reconnectDelay / 1000).toFixed(0)}s`, "warning");
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
//# sourceMappingURL=bridge.js.map