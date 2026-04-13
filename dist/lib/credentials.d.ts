/**
 * Windows-local secret storage via DPAPI (Data Protection API).
 *
 * Secrets are encrypted with the current Windows user's credentials and stored
 * in a local file. Only the same user on the same machine can decrypt them.
 * No native modules are required.
 */
export declare function getApiKey(): string | null;
export declare function setApiKey(key: string): void;
export declare function clearApiKey(): void;
export declare function getAuthToken(): string | null;
export declare function setAuthToken(token: string): void;
export declare function clearAuthToken(): void;
export declare function hasApiKey(): boolean;
export declare function hasAuthToken(): boolean;
export declare function clearCredentials(): void;
