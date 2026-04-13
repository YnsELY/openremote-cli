import { existsSync } from "node:fs";
import { log } from "./logger.js";
import { CodexRunner } from "./codex-runner.js";
/**
 * Manages a single Codex session at a time.
 * Receives commands from the bridge, delegates to CodexRunner,
 * and streams results back through the bridge.
 */
export class SessionManager {
    bridge;
    apiKey;
    runner = new CodexRunner();
    activeSessionId = null;
    constructor(bridge, apiKey) {
        this.bridge = bridge;
        this.apiKey = apiKey;
        this.wireRunnerEvents();
    }
    handleMessage(msg) {
        switch (msg.type) {
            case "session:start":
                this.handleStart(msg.payload);
                break;
            case "session:cancel":
                this.handleCancel(msg.payload.sessionId);
                break;
            case "session:respond":
                this.handleRespond(msg.payload.sessionId, msg.payload.optionIndex);
                break;
            case "session:input":
                this.handleInput(msg.payload);
                break;
            case "session:finish":
                this.handleFinish(msg.payload.sessionId);
                break;
            default:
                break;
        }
    }
    shutdown() {
        this.runner.killAll();
        this.activeSessionId = null;
    }
    get busy() {
        return this.activeSessionId !== null;
    }
    handleStart(payload) {
        if (this.activeSessionId) {
            if (payload.forceReplace) {
                const previousSessionId = this.activeSessionId;
                log.step("Replacing the active session");
                this.runner.finishSession(previousSessionId);
            }
        }
        if (this.activeSessionId) {
            log.card("Machine busy", ["Finish the current session or wait for it to become idle."], "warning");
            this.bridge.send({
                type: "session:busy",
                payload: { sessionId: payload.sessionId },
            });
            return;
        }
        if (!existsSync(payload.projectPath)) {
            log.card("Invalid project path", [payload.projectPath], "danger");
            this.bridge.send({
                type: "session:error",
                payload: {
                    sessionId: payload.sessionId,
                    error: `Project path does not exist: ${payload.projectPath}`,
                },
            });
            this.bridge.send({
                type: "session:status",
                payload: {
                    sessionId: payload.sessionId,
                    status: "failed",
                },
            });
            return;
        }
        log.step("Starting a new session");
        log.setDashboard({
            sessionId: `${payload.sessionId.slice(0, 8)}...`,
            sessionState: "queued",
            sessionDetail: "Preparing the remote session",
            modelName: payload.modelName,
            reasoning: payload.reasoningEffort,
            approvalMode: payload.approvalMode,
        });
        log.clearInfoBar();
        this.activeSessionId = payload.sessionId;
        this.runner.startSession(payload.sessionId, payload.projectPath, payload.prompt, payload.modelName, payload.reasoningEffort, payload.approvalMode, this.apiKey, null);
    }
    handleCancel(sessionId) {
        if (sessionId !== this.activeSessionId)
            return;
        log.step("Cancelling the current session");
        this.runner.cancelSession(sessionId);
    }
    handleRespond(sessionId, optionIndex) {
        if (sessionId !== this.activeSessionId)
            return;
        log.debug(`Approval response: option ${optionIndex}`);
        this.runner.respondToSession(sessionId, optionIndex);
    }
    handleInput(payload) {
        if (payload.sessionId !== this.activeSessionId && this.activeSessionId) {
            if (payload.forceReplace) {
                const previousSessionId = this.activeSessionId;
                log.step("Replacing the active session for follow-up input");
                this.runner.finishSession(previousSessionId);
            }
        }
        if (payload.sessionId !== this.activeSessionId && this.activeSessionId) {
            log.card("Couldn't send your message", ["Another session is still active on this machine."], "warning");
            return;
        }
        if (payload.sessionId !== this.activeSessionId) {
            if (!payload.projectPath || !payload.approvalMode) {
                log.card("Missing session metadata", ["Open the session again after the app refreshes its data."], "warning");
                this.bridge.send({
                    type: "session:error",
                    payload: {
                        sessionId: payload.sessionId,
                        error: "Session metadata missing for resume",
                    },
                });
                return;
            }
            log.step("Resuming the selected session");
            log.setDashboard({
                sessionId: `${payload.sessionId.slice(0, 8)}...`,
                sessionState: "resuming",
                sessionDetail: "Reopening the selected conversation",
                modelName: payload.modelName ?? "gpt-5.4",
                reasoning: payload.reasoningEffort ?? "medium",
                approvalMode: payload.approvalMode,
            });
            log.clearInfoBar();
            this.activeSessionId = payload.sessionId;
            this.runner.resumeSession(payload.sessionId, payload.projectPath, payload.text, payload.modelName ?? "gpt-5.4", payload.reasoningEffort ?? "medium", payload.approvalMode, this.apiKey, payload.codexSessionId ?? null);
            return;
        }
        const { sessionId, text } = payload;
        log.step("Sending your follow-up");
        const followUpDashboard = {
            sessionId: `${sessionId.slice(0, 8)}...`,
            sessionState: "running",
            sessionDetail: "Sending a follow-up to Codex",
        };
        if (payload.modelName) {
            followUpDashboard.modelName = payload.modelName;
        }
        if (payload.reasoningEffort) {
            followUpDashboard.reasoning = payload.reasoningEffort;
        }
        log.setDashboard(followUpDashboard);
        log.clearInfoBar();
        this.runner.inputToSession(sessionId, text, payload.modelName, payload.reasoningEffort);
    }
    handleFinish(sessionId) {
        if (sessionId !== this.activeSessionId)
            return;
        log.step("Finishing the current session");
        this.runner.finishSession(sessionId);
    }
    wireRunnerEvents() {
        this.runner.on("output", (sid, data) => {
            this.bridge.send({
                type: "session:output",
                payload: { sessionId: sid, data, timestamp: Date.now() },
            });
        });
        this.runner.on("status", (sid, status) => {
            if (status === "running") {
                log.setDashboard({
                    sessionId: `${sid.slice(0, 8)}...`,
                    sessionState: "running",
                    sessionDetail: "Codex is working on your request",
                });
                log.clearInfoBar();
                log.step("Session running");
            }
            else if (status === "idle") {
                log.setDashboard({
                    sessionId: `${sid.slice(0, 8)}...`,
                    sessionState: "idle",
                    sessionDetail: "Waiting for a follow-up",
                });
                log.clearInfoBar();
                log.ok("Session completed");
                log.step("Waiting for the next prompt");
            }
            else if (status === "busy") {
                log.setDashboard({
                    sessionId: `${sid.slice(0, 8)}...`,
                    sessionState: "approval",
                    sessionDetail: "Waiting for approval",
                });
                log.infoBar("Approval required to continue.", "warning");
                log.step("Approval required");
            }
            else if (status === "queued") {
                log.setDashboard({
                    sessionId: `${sid.slice(0, 8)}...`,
                    sessionState: "queued",
                    sessionDetail: "Preparing the session",
                });
                log.clearInfoBar();
                log.step("Preparing the session");
            }
            else if (status === "cancelled") {
                log.setDashboard({
                    sessionId: "-",
                    sessionState: "idle",
                    sessionDetail: "Waiting for a remote session",
                });
                log.clearInfoBar();
                log.ok("Session cancelled");
            }
            else if (status === "completed") {
                log.setDashboard({
                    sessionId: "-",
                    sessionState: "idle",
                    sessionDetail: "Waiting for a remote session",
                });
                log.clearInfoBar();
                log.ok("Session closed");
            }
            else if (status === "failed") {
                log.setDashboard({
                    sessionId: `${sid.slice(0, 8)}...`,
                    sessionState: "failed",
                    sessionDetail: "The session failed",
                });
                log.infoBar("Session failed. Review the error below.", "danger");
                log.error("Session failed");
            }
            else {
                log.debug(`Session ${sid} status -> ${status}`);
            }
            this.bridge.send({
                type: "session:status",
                payload: { sessionId: sid, status },
            });
        });
        this.runner.on("approval", (sid, message, options) => {
            log.setDashboard({
                sessionId: `${sid.slice(0, 8)}...`,
                sessionState: "approval",
                sessionDetail: "Waiting for approval",
            });
            // Approval card is only sent to the remote app, not displayed in CLI
            this.bridge.send({
                type: "session:approval",
                payload: {
                    sessionId: sid,
                    message,
                    options: options.map((option) => ({
                        label: option.label,
                        index: option.index,
                    })),
                },
            });
        });
        this.runner.on("complete", (sid, exitCode, duration) => {
            const sec = (duration / 1000).toFixed(1);
            log.setDashboard({
                sessionId: "-",
                sessionState: "idle",
                sessionDetail: "Waiting for a remote session",
            });
            log.clearInfoBar();
            log.summary("Session finished", [
                ["Session", `${sid.slice(0, 8)}...`],
                ["Exit code", String(exitCode)],
                ["Duration", `${sec}s`],
            ]);
            this.bridge.send({
                type: "session:complete",
                payload: { sessionId: sid, exitCode, duration },
            });
            this.activeSessionId = null;
            log.step("Waiting for a session");
        });
        this.runner.on("error", (sid, error) => {
            log.setDashboard({
                sessionId: `${sid.slice(0, 8)}...`,
                sessionState: "failed",
                sessionDetail: "The session failed",
            });
            log.infoBar("Session failed. Review the error below.", "danger");
            log.card("Session error", [error], "danger");
            this.bridge.send({
                type: "session:error",
                payload: { sessionId: sid, error },
            });
        });
        this.runner.on("codexSession", (sid, codexSessionId) => {
            log.debug(`Session ${sid.slice(0, 8)}... codex session -> ${codexSessionId}`);
            this.bridge.send({
                type: "session:meta",
                payload: { sessionId: sid, codexSessionId },
            });
        });
    }
}
//# sourceMappingURL=session.js.map