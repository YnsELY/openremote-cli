import path from "node:path";

function quotePosix(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function getUnixShell(): string {
  if (process.env.SHELL && process.env.SHELL.trim()) {
    return process.env.SHELL.trim();
  }
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

export function buildShellCommand(command: string, args: string[]): string {
  return [command, ...args.map((arg) => quotePosix(arg))].join(" ");
}

export function getShellLaunch(): { shell: string; argsForCommand: (command: string) => string[] } {
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
