import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = Object.entries(lock.packages ?? {}).filter(([name]) => name);
const failures = [];

const requiredPackages = new Map([
  ["node_modules/fast-uri", {
    version: "3.1.7",
    resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.7.tgz",
    integrity: "sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg=="
  }],
  ["node_modules/serialize-javascript", {
    version: "7.1.1",
    resolved: "https://registry.npmjs.org/serialize-javascript/-/serialize-javascript-7.1.1.tgz",
    integrity: "sha512-k3CMsaIvvdSwm8oLB4MXSl0wH2/cwlH7xGcnRd2DaeRmBkbzYmyT8j0tsX60DwD1eRwHTpNpH8ljKu9oUT1MeQ=="
  }]
]);

const allowedInstallScripts = new Set([
  "node_modules/esbuild@0.28.2",
  "node_modules/fsevents@2.3.3"
]);

for (const [name, metadata] of packages) {
  if (metadata.resolved) {
    if (!metadata.resolved.startsWith("https://registry.npmjs.org/")) {
      failures.push(`${name}: unreviewed package source ${metadata.resolved}`);
    }
    if (!metadata.integrity) failures.push(`${name}: resolved package has no integrity hash`);
  }

  if (metadata.hasInstallScript) {
    const identity = `${name}@${metadata.version}`;
    if (!allowedInstallScripts.has(identity)) {
      failures.push(`${identity}: installation script is not reviewed in SUPPLY-CHAIN.md`);
    }
  }
}

for (const identity of allowedInstallScripts) {
  const separator = identity.lastIndexOf("@");
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  const metadata = lock.packages?.[name];
  if (!metadata?.hasInstallScript || metadata.version !== version) {
    failures.push(`${identity}: reviewed installation-script entry is absent or changed`);
  }
}

for (const [name, expected] of requiredPackages) {
  const metadata = lock.packages?.[name];
  for (const [field, value] of Object.entries(expected)) {
    if (metadata?.[field] !== value) {
      failures.push(`${name}: reviewed ${field} is ${value}, found ${metadata?.[field] ?? "absent"}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`dependency lock policy: ${packages.length} package entries checked`);
}
