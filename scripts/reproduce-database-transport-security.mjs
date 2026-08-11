import assert from "node:assert/strict";
import {
  assertSecureDatabaseTransport,
  databaseOptionsWithSchema,
  parseDatabaseUrl
} from "../src/lib/database-url.ts";

const remoteUrl = "mariadb://brainvault:strong-secret@db.example.internal:3306/brainvault?ssl=true";

function legacyDatabaseOptions(rawUrl) {
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || undefined
  };
}

const legacy = legacyDatabaseOptions(remoteUrl);
assert.equal(Object.hasOwn(legacy, "ssl"), false);

const fixed = databaseOptionsWithSchema(parseDatabaseUrl(remoteUrl, { requireDatabase: true }));
assert.equal(fixed.ssl, true);

assert.throws(
  () => assertSecureDatabaseTransport(
    "mariadb://brainvault:strong-secret@db.example.internal:3306/brainvault",
    { production: true, name: "DATABASE_URL" }
  ),
  /must enable TLS with \?ssl=true/
);

console.log(JSON.stringify({
  legacy: { connectorSslOptionPresent: Object.hasOwn(legacy, "ssl") },
  fixed: { connectorSsl: fixed.ssl },
  remoteProductionPlaintext: "rejected"
}, null, 2));
