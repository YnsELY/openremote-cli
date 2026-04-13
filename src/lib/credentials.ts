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

interface CredentialStore {
  openaiApiKey?: string;
  authToken?: string;
}

function credFile(): string {
  return join(getConfigDir(), "credentials.enc");
}

function dpApiEncrypt(plaintext: string): string {
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

function dpApiDecrypt(encrypted: string): string {
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

function loadStore(): CredentialStore {
  const file = credFile();
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, "utf-8").trim();
    const json = dpApiDecrypt(raw);
    return JSON.parse(json) as CredentialStore;
  } catch {
    return {};
  }
}

function saveStore(store: CredentialStore): void {
  if (!store.openaiApiKey && !store.authToken) {
    clearCredentials();
    return;
  }

  const json = JSON.stringify(store);
  const encrypted = dpApiEncrypt(json);
  ensureConfigDir();
  writeFileSync(credFile(), encrypted, "utf-8");
}

function updateStore(mutator: (store: CredentialStore) => void): void {
  const store = loadStore();
  mutator(store);
  saveStore(store);
}

export function getApiKey(): string | null {
  return loadStore().openaiApiKey ?? null;
}

export function setApiKey(key: string): void {
  updateStore((store) => {
    store.openaiApiKey = key;
  });
}

export function clearApiKey(): void {
  updateStore((store) => {
    delete store.openaiApiKey;
  });
}

export function getAuthToken(): string | null {
  return loadStore().authToken ?? null;
}

export function setAuthToken(token: string): void {
  updateStore((store) => {
    store.authToken = token;
  });
}

export function clearAuthToken(): void {
  updateStore((store) => {
    delete store.authToken;
  });
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

export function hasAuthToken(): boolean {
  return !!getAuthToken();
}

export function clearCredentials(): void {
  const file = credFile();
  if (existsSync(file)) unlinkSync(file);
}
