import { resolve } from "node:path";

export async function checkWebpFiles(urls: Iterable<string>, publicDirectory: string): Promise<void> {
  for (const url of new Set(urls)) {
    const file = Bun.file(resolve(publicDirectory, url.replace(/^\//, "")));
    if (!(await file.exists())) throw new Error(`Missing image: ${url}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
        bytes.toString("ascii", 8, 12) !== "WEBP") {
      throw new Error(`Invalid WebP image: ${url}`);
    }
  }
}
