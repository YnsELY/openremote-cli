// Config

export interface AppConfig {
  machineId: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  userDisplayName: string | null;
  createdAt: string;
  lastSeenAt: string;
  cliVersion: string;
  backendUrl?: string;
}

export type MachineAvailabilityState =
  | "offline"
  | "idle"
  | "busy"
  | "revoked";

// Codex session

export type SessionStatus =
  | "queued"
  | "running"
  | "busy"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

export interface ParsedOption {
  index: number;
  label: string;
  shortcutKey: string | null;
}

// Bridge protocol (CLI <-> Backend)

// CLI -> Backend
export interface MachineHelloMsg {
  type: "machine:hello";
  payload: { machineId: string; authToken: string };
}

export interface MachineOfflineMsg {
  type: "machine:offline";
  payload: { machineId: string };
}

export interface SessionOutputMsg {
  type: "session:output";
  payload: { sessionId: string; data: string; timestamp: number };
}

export interface SessionStatusMsg {
  type: "session:status";
  payload: { sessionId: string; status: SessionStatus };
}

export interface SessionApprovalMsg {
  type: "session:approval";
  payload: {
    sessionId: string;
    message: string;
    options: { label: string; index: number }[];
  };
}

export interface SessionCompleteMsg {
  type: "session:complete";
  payload: { sessionId: string; exitCode: number; duration: number };
}

export interface SessionErrorMsg {
  type: "session:error";
  payload: { sessionId: string; error: string };
}

export interface SessionBusyMsg {
  type: "session:busy";
  payload: { sessionId: string };
}

export interface SessionMetaMsg {
  type: "session:meta";
  payload: { sessionId: string; codexSessionId: string };
}

export type OutboundMessage =
  | MachineHelloMsg
  | MachineOfflineMsg
  | SessionOutputMsg
  | SessionStatusMsg
  | SessionApprovalMsg
  | SessionCompleteMsg
  | SessionErrorMsg
  | SessionBusyMsg
  | SessionMetaMsg;

// Backend -> CLI
export interface MachineReadyMsg {
  type: "machine:ready";
  payload: Record<string, never>;
}

export interface SessionStartMsg {
  type: "session:start";
  payload: {
    sessionId: string;
    prompt: string;
    modelName: string;
    reasoningEffort: string;
    projectPath: string;
    approvalMode: "full-auto" | "auto-edit" | "suggest";
    forceReplace?: boolean;
  };
}

export interface SessionCancelMsg {
  type: "session:cancel";
  payload: { sessionId: string };
}

export interface SessionRespondMsg {
  type: "session:respond";
  payload: { sessionId: string; optionIndex: number };
}

export interface SessionInputMsg {
  type: "session:input";
  payload: {
    sessionId: string;
    text: string;
    modelName?: string;
    reasoningEffort?: string;
    projectPath?: string;
    approvalMode?: "full-auto" | "auto-edit" | "suggest";
    codexSessionId?: string | null;
    forceReplace?: boolean;
  };
}

export interface SessionFinishMsg {
  type: "session:finish";
  payload: { sessionId: string };
}

export type InboundMessage =
  | MachineReadyMsg
  | SessionStartMsg
  | SessionCancelMsg
  | SessionRespondMsg
  | SessionInputMsg
  | SessionFinishMsg;

// Ingest

export interface SessionIngestEvent {
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface SessionIngestOutputSegment {
  seq: number;
  text: string;
  byteCount: number;
  occurredAt: string;
}

export type SessionReadableBlockKind =
  | "thinking"
  | "command"
  | "output"
  | "text"
  | "code"
  | "path"
  | "error"
  | "status";

export interface SessionReadableBlockIngest {
  seq: number;
  kind: SessionReadableBlockKind;
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
}

export interface SessionPatch {
  status?: SessionStatus;
  exitCode?: number | null;
  durationMs?: number | null;
  completedAt?: string | null;
  codexSessionId?: string | null;
}

// Runner events

export interface RunnerEvents {
  output: (sessionId: string, data: string) => void;
  error: (sessionId: string, error: string) => void;
  status: (sessionId: string, status: SessionStatus) => void;
  complete: (sessionId: string, exitCode: number, duration: number) => void;
  approval: (sessionId: string, message: string, options: ParsedOption[]) => void;
  codexSession: (sessionId: string, codexSessionId: string) => void;
}
