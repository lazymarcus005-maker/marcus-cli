import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const packageDirectories = execFileSync("npm", ["ls", "--all", "--parseable", "--omit=dev"], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
}).trim().split(/\r?\n/).filter(Boolean);

const packages = new Map();
for (const directory of packageDirectories) {
  const manifestPath = join(directory, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.name || manifest.name === root.name || !manifest.version) continue;
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) continue;
  const licenseFiles = readdirSync(directory).filter((name) => /^(licen[cs]e|copying)(?:\.|$)/i.test(name));
  packages.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? null,
    licenseFiles,
  });
}

const licenseCounts = {};
for (const dependency of packages.values()) {
  const identifier = typeof dependency.license === "string"
    ? dependency.license
    : dependency.license === null ? "UNDECLARED" : JSON.stringify(dependency.license);
  licenseCounts[identifier] = (licenseCounts[identifier] ?? 0) + 1;
}

const undeclaredLicenses = [...packages.values()]
  .filter((dependency) => dependency.license === null)
  .map(({ name, version }) => `${name}@${version}`);
const missingLicenseFiles = [...packages.values()]
  .filter((dependency) => dependency.licenseFiles.length === 0)
  .map(({ name, version, license }) => ({ name, version, declaredLicense: license }));
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  applicationLicense: root.license ?? null,
  productionPackageCount: packages.size,
  directDependencies: Object.entries(root.dependencies ?? {}).map(([name, version]) => ({
    name,
    version,
    license: packages.get(`${name}@${version}`)?.license ?? null,
  })),
  licenseCounts,
  undeclaredLicenses,
  missingLicenseFiles,
}, null, 2)}\n`);
if (undeclaredLicenses.length > 0) process.exitCode = 1;
