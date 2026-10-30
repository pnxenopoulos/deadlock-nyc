import { validateEncoder, validateManifest } from "../src/ml/features";
/** Mirror verified public release assets for browser CORS compatibility. No demo data. */
import { mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(
  new URL("../public/models/win-probability", import.meta.url),
);
const api =
  "https://api.github.com/repos/pnxenopoulos/deadlock-win-prob/releases/latest";
const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "deadlock.nyc model-build",
};
if (process.env.GITHUB_TOKEN)
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const release = await fetch(api, { headers }).then(async (r) => {
  if (!r.ok) throw new Error(`Model release discovery failed: ${r.status}`);
  return (await r.json()) as {
    tag_name: string;
    draft: boolean;
    assets: { name: string; url: string; digest?: string }[];
  };
});
if (release.draft) throw new Error("Cannot deploy a draft model.");
const temporary = directory.replace(/\/$/, "") + ".download";
await mkdir(temporary, { recursive: true });
try {
  const bytes: Record<string, Uint8Array> = {};
  for (const name of ["manifest.json", "encoder.json", "model.onnx"]) {
    const asset = release.assets.find((a) => a.name === name);
    if (!asset || !asset.digest?.startsWith("sha256:"))
      throw new Error(`Missing model release asset or checksum: ${name}`);
    const response = await fetch(asset.url, {
      headers: { ...headers, Accept: "application/octet-stream" },
    });
    if (!response.ok)
      throw new Error(`Model download failed: ${name} (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (
      "sha256:" + createHash("sha256").update(data).digest("hex") !==
      asset.digest
    )
      throw new Error(`Model release checksum mismatch: ${name}`);
    bytes[name] = data;
  }
  const manifest = JSON.parse(new TextDecoder().decode(bytes["manifest.json"]));
  if (
    manifest.format_version !== 1 ||
    manifest.model_version !== release.tag_name
  )
    throw new Error("Unsupported model release manifest.");
  validateManifest(manifest);
  validateEncoder(JSON.parse(new TextDecoder().decode(bytes["encoder.json"])));
  for (const name of ["model.onnx", "encoder.json"])
    if (
      createHash("sha256").update(bytes[name]).digest("hex") !==
      manifest.sha256[name]
    )
      throw new Error(`Mixed model assets: ${name}`);
  for (const [name, data] of Object.entries(bytes))
    await Bun.write(`${temporary}/${name}`, data);
  await rm(directory, { recursive: true, force: true });
  await rename(temporary, directory);
  console.log(`Bundled win probability model ${release.tag_name}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
