import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPoshAcmeTls,
  resolvePoshAcmeCertificateFiles
} from "../src/lib/posh-acme-https.js";

const temporaryDirectories: string[] = [];
const opensslAvailable = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const opensslIt = opensslAvailable ? it : it.skip;

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "brainvault-posh-acme-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createSelfSignedCertificate(directory: string, hostname: string) {
  const certificateFile = path.join(directory, "fullchain.cer");
  const privateKeyFile = path.join(directory, "cert.key");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      `/CN=${hostname}`,
      "-addext",
      `subjectAltName=DNS:${hostname}`,
      "-keyout",
      privateKeyFile,
      "-out",
      certificateFile
    ],
    { stdio: "ignore" }
  );
  return { certificateFile, privateKeyFile };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Posh-ACME HTTPS file loading", () => {
  it("accepts either an order directory or an explicit FullChainFile path", async () => {
    const directory = await createTemporaryDirectory();
    const certificateFile = path.join(directory, "fullchain.cer");
    const privateKeyFile = path.join(directory, "cert.key");
    await Promise.all([writeFile(certificateFile, "certificate"), writeFile(privateKeyFile, "private-key")]);

    await expect(resolvePoshAcmeCertificateFiles(directory)).resolves.toEqual({
      certificateFile,
      privateKeyFile
    });
    await expect(resolvePoshAcmeCertificateFiles(certificateFile)).resolves.toEqual({
      certificateFile,
      privateKeyFile
    });
  });

  it("fails closed when cert.key is absent", async () => {
    const directory = await createTemporaryDirectory();
    await writeFile(path.join(directory, "fullchain.cer"), "certificate");

    await expect(resolvePoshAcmeCertificateFiles(directory)).rejects.toThrow("Posh-ACME private-key file is not accessible");
  });

  opensslIt("loads a valid PEM certificate/key pair and validates PUBLIC_ORIGIN", async () => {
    const directory = await createTemporaryDirectory();
    const { certificateFile, privateKeyFile } = createSelfSignedCertificate(directory, "notes.example.com");

    const loaded = await loadPoshAcmeTls(directory, "https://notes.example.com");

    expect(loaded.files).toEqual({ certificateFile, privateKeyFile });
    expect(loaded.options.minVersion).toBe("TLSv1.2");
    expect(Buffer.isBuffer(loaded.options.cert)).toBe(true);
    expect(Buffer.isBuffer(loaded.options.key)).toBe(true);
    await expect(loadPoshAcmeTls(directory, "https://wrong.example.com")).rejects.toThrow(
      "does not cover PUBLIC_ORIGIN hostname wrong.example.com"
    );
  });
});
