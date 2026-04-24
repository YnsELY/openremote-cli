#!/usr/bin/env node
import { Command } from "commander";
import { setupCommand } from "./commands/setup.js";
import { loginCommand } from "./commands/login.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { doctorCommand } from "./commands/doctor.js";
import { logoutCommand } from "./commands/logout.js";
import { configureLogger } from "./lib/logger.js";
import { printBanner } from "./lib/banner.js";
import { CLI_VERSION } from "./lib/version.js";
// Display OpenRemote banner
printBanner();
const program = new Command();
function withCliContext(action) {
    return async (...args) => {
        const command = args[args.length - 1];
        configureLogger({ verbose: Boolean(command?.optsWithGlobals?.().verbose) });
        await action();
    };
}
program
    .name("openremote")
    .description("Control OpenAI Codex from your iPhone")
    .version(CLI_VERSION)
    .option("--verbose", "Show debug output below the premium UI");
program
    .command("setup")
    .description("Configure OpenRemote: check CLI dependencies and create config")
    .action(withCliContext(setupCommand));
program
    .command("login")
    .description("Authenticate via browser and associate this machine to your account")
    .action(withCliContext(loginCommand));
program
    .command("start")
    .description("Connect to the backend and accept remote Codex sessions")
    .action(withCliContext(startCommand));
program
    .command("status")
    .description("Show current configuration, credentials, and readiness")
    .action(withCliContext(statusCommand));
program
    .command("doctor")
    .description("Run diagnostics on your environment and configuration")
    .action(withCliContext(doctorCommand));
program
    .command("logout")
    .description("Remove auth token and optionally the API key")
    .action(withCliContext(logoutCommand));
program.parse();
//# sourceMappingURL=index.js.map