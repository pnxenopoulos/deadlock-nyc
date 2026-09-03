import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function findSource2ViewerCli(root: string): string | null {
  const candidates = [
    process.env.SOURCE2VIEWER_CLI,
    resolve(root, "../cli-linux-x64/Source2Viewer-CLI"),
    Bun.which("Source2Viewer-CLI"),
    Bun.which("Source2Viewer-CLI.exe"),
    Bun.which("source2viewer-cli"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = resolve(candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

export function source2ViewerEnv(cli: string): Record<string, string | undefined> {
  const cliDir = dirname(cli);
  const current = process.env.LD_LIBRARY_PATH;
  return {
    ...process.env,
    LD_LIBRARY_PATH: current ? `${cliDir}:${current}` : cliDir,
  };
}
