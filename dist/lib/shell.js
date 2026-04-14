import path from "node:path";
function quotePosix(arg) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
export function getUnixShell() {
    if (process.env.SHELL && process.env.SHELL.trim()) {
        return process.env.SHELL.trim();
    }
    return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
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