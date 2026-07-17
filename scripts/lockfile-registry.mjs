import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const lockfileUrl = new URL('../package-lock.json', import.meta.url);
const publicRegistry = 'https://registry.npmjs.org/';
const defaultAllowedHosts = ['registry.npmjs.org'];
const extraAllowedHosts = (process.env.BRAINVAULT_ALLOWED_NPM_REGISTRY_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const allowedHosts = new Set([...defaultAllowedHosts, ...extraAllowedHosts]);
const shouldFix = process.argv.includes('--fix');

function packageNameFromLocation(location) {
  const marker = 'node_modules/';
  const markerIndex = location.lastIndexOf(marker);
  if (markerIndex < 0) return null;

  const relative = location.slice(markerIndex + marker.length);
  const parts = relative.split('/');
  if (parts[0]?.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0] || null;
}

function canonicalTarballUrl(packageName, version) {
  const unscopedName = packageName.includes('/') ? packageName.split('/').at(-1) : packageName;
  return `${publicRegistry}${packageName}/-/${unscopedName}-${version}.tgz`;
}

function collectForeignRegistryUrls(lockfile) {
  const violations = [];

  for (const [location, metadata] of Object.entries(lockfile.packages ?? {})) {
    const resolved = metadata?.resolved;
    if (typeof resolved !== 'string' || !/^https?:\/\//i.test(resolved)) continue;

    let parsed;
    try {
      parsed = new URL(resolved);
    } catch {
      violations.push({ location, resolved, host: '(invalid URL)', metadata });
      continue;
    }

    const host = parsed.hostname.toLowerCase();
    if (!allowedHosts.has(host)) {
      violations.push({ location, resolved, host, metadata });
    }
  }

  return violations;
}

let source;
try {
  source = await readFile(lockfileUrl, 'utf8');
} catch (error) {
  console.error('[lockfile-registry] package-lock.json is required and could not be read.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let lockfile;
try {
  lockfile = JSON.parse(source);
} catch (error) {
  console.error('[lockfile-registry] package-lock.json is not valid JSON.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let violations = collectForeignRegistryUrls(lockfile);

if (shouldFix && violations.length > 0) {
  let updatedSource = source;
  let repaired = 0;
  const skipped = [];

  for (const violation of violations) {
    const packageName = packageNameFromLocation(violation.location);
    const version = violation.metadata?.version;

    if (!packageName || typeof version !== 'string' || version.length === 0) {
      skipped.push(violation);
      continue;
    }

    const replacement = canonicalTarballUrl(packageName, version);
    if (!updatedSource.includes(violation.resolved)) {
      skipped.push(violation);
      continue;
    }

    updatedSource = updatedSource.split(violation.resolved).join(replacement);
    repaired += 1;
  }

  if (repaired > 0) {
    await writeFile(lockfileUrl, updatedSource, 'utf8');
    source = updatedSource;
    lockfile = JSON.parse(source);
    violations = collectForeignRegistryUrls(lockfile);
    console.log(`[lockfile-registry] Repaired ${repaired} registry URL(s).`);
  }

  if (skipped.length > 0) {
    console.error(`[lockfile-registry] Could not safely repair ${skipped.length} URL(s).`);
  }
}

if (violations.length > 0) {
  const hosts = [...new Set(violations.map((item) => item.host))].sort();
  console.error(
    `[lockfile-registry] Found ${violations.length} non-portable registry URL(s) from: ${hosts.join(', ')}`,
  );
  for (const violation of violations.slice(0, 5)) {
    console.error(`  - ${violation.location || '(root)'} -> ${violation.resolved}`);
  }
  if (violations.length > 5) {
    console.error(`  ... and ${violations.length - 5} more`);
  }
  console.error('Run "npm run lockfile:repair" and review the resulting package-lock.json diff.');
  console.error(
    'For an intentional private registry, set BRAINVAULT_ALLOWED_NPM_REGISTRY_HOSTS to a comma-separated allowlist.',
  );
  process.exit(1);
}

const resolvedCount = Object.values(lockfile.packages ?? {}).filter(
  (metadata) => typeof metadata?.resolved === 'string',
).length;
console.log(
  `[lockfile-registry] OK: ${resolvedCount} resolved URL(s) use approved portable registry hosts.`,
);
