/**
 * Windows-local secret storage via DPAPI (Data Protection API).
 *
 * Secrets are encrypted with the current Windows user's credentials and stored
 * in a local file. Only the same user on the same machine can decrypt them.
 * No native modules are required.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureConfigDir, getConfigDir } from "./config.js";
function credFile() {
    return join(getConfigDir(), "credentials.enc");
}
function dpApiEncrypt(plaintext) {
    const ps = [
        "Add-Type -AssemblyName System.Security",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($input)",
        "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')",
        "[Convert]::ToBase64String($enc)",
    ].join("; ");
    return execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: "utf-8",
        input: plaintext,
        windowsHide: true,
    }).trim();
}
function dpApiDecrypt(encrypted) {
    const ps = [
        "Add-Type -AssemblyName System.Security",
        `$enc = [Convert]::FromBase64String('${encrypted}')`,
        "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')",
        "[System.Text.Encoding]::UTF8.GetString($bytes)",
    ].join("; ");
    return execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: "utf-8",
        windowsHide: true,
    }).trim();
}
function loadStore() {
    const file = credFile();
    if (!existsSync(file))
        return {};
    try {
        const raw = readFileSync(file, "utf-8").trim();
        const json = dpApiDecrypt(raw);
        return JSON.parse(json);
    }
    catch {
        return {};
    }
}
function saveStore(store) {
    if (!store.openaiApiKey && !store.authToken) {
        clearCredentials();
        return;
    }
    const json = JSON.stringify(store);
    const encrypted = dpApiEncrypt(json);
    ensureConfigDir();
    writeFileSync(credFile(), encrypted, "utf-8");
}
function updateStore(mutator) {
    const store = loadStore();
    mutator(store);
    saveStore(store);
}
export function getApiKey() {
    return loadStore().openaiApiKey ?? null;
}
export function setApiKey(key) {
    updateStore((store) => {
        store.openaiApiKey = key;
    });
}
export function clearApiKey() {
    updateStore((store) => {
        delete store.openaiApiKey;
    });
}
export function getAuthToken() {
    return loadStore().authToken ?? null;
}
export function setAuthToken(token) {
    updateStore((store) => {
        store.authToken = token;
    });
}
export function clearAuthToken() {
    updateStore((store) => {
        delete store.authToken;
    });
}
export function hasApiKey() {
    return !!getApiKey();
}
export function hasAuthToken() {
    return !!getAuthToken();
}
export function clearCredentials() {
    const file = credFile();
    if (existsSync(file))
        unlinkSync(file);
}
//# sourceMappingURL=credentials.js.map