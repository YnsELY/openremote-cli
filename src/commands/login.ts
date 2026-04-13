import readline from "node:readline";
import { log } from "../lib/logger.js";
import { loadConfig, updateConfig } from "../lib/config.js";
import { setAuthToken, hasAuthToken } from "../lib/credentials.js";

export async function loginCommand(): Promise<void> {
  log.header("OpenRemote");

  const config = loadConfig();
  if (!config) {
    log.card("Missing configuration", ["Run openremote setup first."], "danger");
    process.exit(1);
  }

  if (hasAuthToken()) {
    log.summary("Already logged in", [
      ["User", config.userDisplayName ?? "Unknown"],
      ["Machine", `${config.machineId.slice(0, 8)}...`],
    ]);
    log.nextStep("Run openremote logout if you want to re-authenticate");
    return;
  }

  const email = await promptInput("Email: ");
  if (!email) {
    log.card("Email is required", ["Enter a valid email address and retry."], "danger");
    process.exit(1);
  }

  const password = await promptPassword("Password: ");
  if (!password) {
    log.card("Password is required", ["Enter your password and retry."], "danger");
    process.exit(1);
  }

  log.step("Authenticating with Supabase");

  const response = await fetch(`${config.supabaseUrl}/functions/v1/auth-login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      apikey: config.supabaseAnonKey,
    },
    body: JSON.stringify({
      email: email.trim(),
      password,
      machineId: config.machineId,
      platform: process.platform,
      cliVersion: config.cliVersion,
    }),
  });

  if (!response.ok) {
    let message = `Authentication failed (${response.status})`;
    try {
      const body = await response.json();
      if (body.message) message = body.message;
    } catch {
      // Ignore JSON parse errors
    }

    const hint =
      response.status === 401
        ? "Check your email and password."
        : response.status === 409
          ? "This machine is already linked to another account."
          : "Check your network and retry.";

    log.card("Couldn't log in", [message, hint], "danger");
    process.exit(1);
  }

  const data = (await response.json()) as {
    token: string;
    displayName: string;
    email: string;
  };

  setAuthToken(data.token);
  updateConfig({ userDisplayName: data.displayName });

  log.ok("You're connected");
  log.summary("Login complete", [
    ["User", data.displayName],
    ["Email", data.email],
    ["Machine", `${config.machineId.slice(0, 8)}...`],
  ]);
  log.nextStep("Run openremote start");
}

function promptInput(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptPassword(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    let password = "";

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdout.write(message);

    const onData = (chunk: Buffer) => {
      const ch = chunk.toString("utf-8");

      if (ch === "\r" || ch === "\n") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(password);
        return;
      }

      if (ch === "\x03") {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.removeListener("data", onData);
        rl.close();
        process.exit(0);
        return;
      }

      if (ch === "\x7f" || ch === "\b") {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      password += ch;
      process.stdout.write("*");
    };

    process.stdin.on("data", onData);
  });
}
