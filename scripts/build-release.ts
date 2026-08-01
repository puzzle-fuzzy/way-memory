import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const configuredOutput = Bun.env.WAY_MEMORY_RELEASE_DIR ?? ".release/way-memory";
const releaseRoot = resolve(repositoryRoot, configuredOutput);

function isInside(parent: string, candidate: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate.toLowerCase().startsWith(normalizedParent.toLowerCase());
}

if (!isInside(repositoryRoot, releaseRoot) || releaseRoot.toLowerCase() === repositoryRoot.toLowerCase()) {
  throw new Error(`release_output_must_be_inside_repository: ${releaseRoot}`);
}

for (const protectedPath of [resolve(repositoryRoot, ".git"), resolve(repositoryRoot, "node_modules")]) {
  if (releaseRoot.toLowerCase() === protectedPath.toLowerCase() || isInside(protectedPath, releaseRoot)) {
    throw new Error(`release_output_is_protected: ${releaseRoot}`);
  }
}

async function run(command: string[]): Promise<void> {
  console.log(`\n> ${command.join(" ")}`);
  const process = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`command_failed_${exitCode}: ${command.join(" ")}`);
}

function capture(command: string[]): string {
  const result = Bun.spawnSync(command, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`command_failed_${result.exitCode}: ${command.join(" ")} ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release_symlink_not_allowed: ${absolutePath}`);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const contents = await readFile(path);
  return {
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

console.log(`Preparing release bundle at ${releaseRoot}`);
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(join(releaseRoot, "api"), { recursive: true });
await mkdir(join(releaseRoot, "deploy", "tencent-cloud"), { recursive: true });

await run(["bun", "run", "build:web"]);
await cp(resolve(repositoryRoot, "apps", "web", "dist"), join(releaseRoot, "web"), { recursive: true });

await run([
  "bun",
  "build",
  "services/api/src/index.ts",
  "--target",
  "bun",
  "--outfile",
  join(releaseRoot, "api", "way-memory-api.js"),
]);

const deploymentFiles = [
  "install-release.sh",
  "way-memory-api.production.service",
  "way-memory.yxswy.com.nginx.conf.example",
];
for (const fileName of deploymentFiles) {
  await cp(
    resolve(repositoryRoot, "deploy", "tencent-cloud", fileName),
    join(releaseRoot, "deploy", "tencent-cloud", fileName),
  );
}
await cp(
  resolve(repositoryRoot, "docs", "deployment", "tencent-cloud.md"),
  join(releaseRoot, "deploy", "tencent-cloud", "README.md"),
);

const sourceCommit = capture(["git", "rev-parse", "HEAD"]);
const sourceCommitDate = capture(["git", "show", "-s", "--format=%cI", "HEAD"]);
const files = [];
for (const absolutePath of await collectFiles(releaseRoot)) {
  const path = relative(releaseRoot, absolutePath).split(sep).join("/");
  if (/(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|keystore|jks))$/i.test(path)) {
    throw new Error(`release_secret_file_not_allowed: ${path}`);
  }
  files.push({ path, ...(await hashFile(absolutePath)) });
}

const manifest = {
  format: "way-memory.release-manifest.v1",
  sourceCommit,
  sourceCommitDate,
  files,
};
await writeFile(join(releaseRoot, "RELEASE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Release bundle ready: ${releaseRoot}`);
console.log(`Manifest: ${join(releaseRoot, "RELEASE-MANIFEST.json")}`);
console.log(`Payload files: ${files.length}`);
