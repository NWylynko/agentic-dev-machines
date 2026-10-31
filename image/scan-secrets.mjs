#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const forbiddenName = /^(?:\.env(?:\..*)?|\.dev\.vars)$/i;
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*(?:[A-Za-z0-9+/=]{20,}\s*)+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA(?!IOSFODNN7EXAMPLE\b)[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
];

export async function scanCredentialArtifacts(root) {
  const findings = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (forbiddenName.test(entry.name)) findings.push(`${relativePath}: credential-shaped filename`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const contents = await readFile(path);
        if (contents.includes(0)) continue;
        const text = contents.toString("utf8");
        for (const pattern of credentialPatterns) {
          if (pattern.test(text)) {
            findings.push(`${relativePath}: credential-shaped content (${pattern})`);
            break;
          }
        }
      }
    }
  }
  await visit(root);
  return findings;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: node image/scan-secrets.mjs EXPORTED_IMAGE_ROOT");
  const findings = await scanCredentialArtifacts(root);
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else console.log(`credential scan passed: ${root}`);
}
