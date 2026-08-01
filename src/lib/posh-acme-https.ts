import { X509Certificate } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createSecureContext, type SecureContextOptions } from "node:tls";

const defaultCertificateFileName = "fullchain.cer";
const defaultPrivateKeyFileName = "cert.key";
const maxTlsFileBytes = 2 * 1024 * 1024;

export type PoshAcmeCertificateFiles = {
  certificateFile: string;
  privateKeyFile: string;
};

export type LoadedPoshAcmeTls = {
  options: SecureContextOptions;
  files: PoshAcmeCertificateFiles;
  certificateSubject: string;
  certificateValidTo: Date;
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function requireRegularTlsFile(filePath: string, label: string) {
  let fileStat: Stats;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    throw new Error(`${label} is not accessible at ${filePath}: ${describeError(error)}`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  if (fileStat.size < 1 || fileStat.size > maxTlsFileBytes) {
    throw new Error(`${label} must be between 1 byte and ${maxTlsFileBytes} bytes: ${filePath}`);
  }
}

export async function resolvePoshAcmeCertificateFiles(
  configuredCertificatePath: string,
  configuredPrivateKeyPath?: string
): Promise<PoshAcmeCertificateFiles> {
  const candidate = path.resolve(configuredCertificatePath);
  let candidateStat: Stats;
  try {
    candidateStat = await stat(candidate);
  } catch (error) {
    throw new Error(`POSH_ACME_CERT_PATH is not accessible at ${candidate}: ${describeError(error)}`);
  }

  let certificateFile: string;
  let defaultKeyDirectory: string;
  if (candidateStat.isDirectory()) {
    certificateFile = path.join(candidate, defaultCertificateFileName);
    defaultKeyDirectory = candidate;
  } else if (candidateStat.isFile()) {
    certificateFile = candidate;
    defaultKeyDirectory = path.dirname(candidate);
  } else {
    throw new Error(`POSH_ACME_CERT_PATH must point to a directory or regular certificate file: ${candidate}`);
  }

  const privateKeyFile = configuredPrivateKeyPath
    ? path.resolve(configuredPrivateKeyPath)
    : path.join(defaultKeyDirectory, defaultPrivateKeyFileName);

  await Promise.all([
    requireRegularTlsFile(certificateFile, "Posh-ACME certificate file"),
    requireRegularTlsFile(privateKeyFile, "Posh-ACME private-key file")
  ]);

  return { certificateFile, privateKeyFile };
}

function validateCertificateIdentity(certificate: X509Certificate, publicOrigin: string) {
  const publicUrl = new URL(publicOrigin);
  const hostname = publicUrl.hostname.replace(/^\[|\]$/g, "");
  const matchedIdentity = net.isIP(hostname)
    ? certificate.checkIP(hostname)
    : certificate.checkHost(hostname);

  if (!matchedIdentity) {
    throw new Error(`The Posh-ACME certificate does not cover PUBLIC_ORIGIN hostname ${hostname}`);
  }
}

function validateCertificateDates(certificate: X509Certificate) {
  const validFrom = new Date(certificate.validFrom);
  const validTo = new Date(certificate.validTo);
  const now = Date.now();

  if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validTo.getTime())) {
    throw new Error("The Posh-ACME certificate contains invalid validity dates");
  }
  if (validFrom.getTime() > now) {
    throw new Error(`The Posh-ACME certificate is not valid before ${validFrom.toISOString()}`);
  }
  if (validTo.getTime() <= now) {
    throw new Error(`The Posh-ACME certificate expired at ${validTo.toISOString()}`);
  }

  return validTo;
}

export async function loadPoshAcmeTls(
  configuredCertificatePath: string,
  publicOrigin: string,
  configuredPrivateKeyPath?: string
): Promise<LoadedPoshAcmeTls> {
  const files = await resolvePoshAcmeCertificateFiles(configuredCertificatePath, configuredPrivateKeyPath);
  let cert: Buffer;
  let key: Buffer;
  try {
    [cert, key] = await Promise.all([readFile(files.certificateFile), readFile(files.privateKeyFile)]);
  } catch (error) {
    throw new Error(`Failed to read the configured Posh-ACME TLS files: ${describeError(error)}`);
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert);
  } catch (error) {
    throw new Error(`The configured Posh-ACME certificate is not valid PEM: ${describeError(error)}`);
  }

  validateCertificateIdentity(certificate, publicOrigin);
  const certificateValidTo = validateCertificateDates(certificate);

  const options: SecureContextOptions = {
    cert,
    key,
    minVersion: "TLSv1.2"
  };

  try {
    createSecureContext(options);
  } catch (error) {
    throw new Error(`The configured Posh-ACME certificate and private key cannot create a TLS context: ${describeError(error)}`);
  }

  return {
    options,
    files,
    certificateSubject: certificate.subject,
    certificateValidTo
  };
}
