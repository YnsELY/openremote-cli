import { existsSync } from "node:fs";
import path from "node:path";
function quotePosix(arg) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
export function getUnixShell() {
    const candidate = process.env.SHELL?.trim();
    if (candidate && existsSync(candidate)) {
        return candidate;
    }
    const fallbacks = process.platform === "darwin"
        ? ["/bin/zsh", "/bin/bash", "/bin/sh"]
        : ["/bin/bash", "/bin/sh", "/usr/bin/bash"];
    for (const fallback of fallbacks) {
        if (existsSync(fallback)) {
            return fallback;
        }
    }
    return "/bin/sh";
}
export function buildShellCommand(command, args) {
    return [command, ...args.map((arg) => quotePosix(arg))].join(" ");
}
export function getShellLaunch() {
    if (process.platform === "win32") {
        return {
            shell: "cmd.exe",
            argsForCommand: (command) => ["/c", command],
        };
    }
    const shell = getUnixShell();
    const base = path.basename(shell).toLowerCase();
    if (base === "fish") {
        return {
            shell,
            argsForCommand: (command) => ["-l", "-c", command],
        };
    }
    return {
        shell,
        argsForCommand: (command) => ["-l", "-c", command],
    };
}
//# sourceMappingURL=shell.js.map