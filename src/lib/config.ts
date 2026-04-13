import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./types.js";

const CONFIG_DIR = join(
  process.env.APPDATA ?? join(process.env.HOME ?? ".", "AppData", "Roaming"),
  "CodexRemote",
);
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function normalizeConfig(raw: Partial<AppConfig>): AppConfig | null {
  const supabaseUrl = raw.supabaseUrl ?? raw.backendUrl;
  if (!raw.machineId || !supabaseUrl || !raw.supabaseAnonKey) {
    return null;
  }

  return {
    machineId: raw.machineId,
    supabaseUrl,
    supabaseAnonKey: raw.supabaseAnonKey,
    userDisplayName: raw.userDisplayName ?? null,
    createdAt: raw.createdAt ?? new Date().toISOString(),
    lastSeenAt: raw.lastSeenAt ?? new Date().toISOString(),
    cliVersion: raw.cliVersion ?? "1.0.0",
    backendUrl: raw.backendUrl,
  };
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function ensureConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  return CONFIG_DIR;
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): AppConfig | null {
  if (!configExists()) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<AppConfig>;
    return normalizeConfig(raw);
  } catch {
    return null;
  }
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig | null {
  const config = loadConfig();
  if (!config) return null;
  const updated = normalizeConfig({
    ...config,
    ...partial,
    lastSeenAt: new Date().toISOString(),
  });
  if (!updated) return null;
  saveConfig(updated);
  return updated;
}
