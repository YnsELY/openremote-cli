import type { SessionReadableBlockIngest } from "./types.js";
interface DerivedReadableBlocksResult {
    blocks: SessionReadableBlockIngest[];
    remainder: string;
}
export declare function sanitizeTerminalText(text: string): string;
export declare function deriveReadableBlocksFromChunk(text: string, seqStart: number, occurredAt: string, options?: {
    final?: boolean;
}): DerivedReadableBlocksResult;
export declare function makeReadableStatusBlock(seq: number, status: string, occurredAt: string, body?: string): SessionReadableBlockIngest;
export declare function makeReadableErrorBlock(seq: number, error: string, occurredAt: string): SessionReadableBlockIngest;
export declare function makeReadableApprovalBlock(seq: number, message: string, occurredAt: string): SessionReadableBlockIngest;
export {};
