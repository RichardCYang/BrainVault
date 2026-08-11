import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSecureDatabaseTransport,
  databaseOptionsWithSchema,
  isLoopbackDatabaseHost,
  parseDatabaseUrl
} from "../src/lib/database-url.ts";

test("database URL TLS intent reaches the MariaDB connector options", () => {
  const parsed = parseDatabaseUrl(
    "mariadb://brainvault:strong-secret@db.example.internal:3306/brainvault?ssl=true",
    { requireDatabase: true }
  );
  const options = databaseOptionsWithSchema(parsed);

  assert.equal(parsed.tls, true);
  assert.equal(options.ssl, true);
  assert.equal(options.database, "brainvault");
});

test("production rejects plaintext transport to remote MariaDB hosts", () => {
  assert.throws(
    () => assertSecureDatabaseTransport(
      "mariadb://brainvault:strong-secret@db.example.internal:3306/brainvault",
      { production: true, name: "DATABASE_URL" }
    ),
    /must enable TLS with \?ssl=true/
  );

  assert.doesNotThrow(() => assertSecureDatabaseTransport(
    "mariadb://brainvault:strong-secret@db.example.internal:3306/brainvault?ssl=true",
    { production: true, name: "DATABASE_URL" }
  ));
});

test("loopback database connections may remain plaintext for local deployment", () => {
  for (const host of ["localhost", "localhost.", "127.0.0.1", "127.10.20.30", "[::1]"]) {
    assert.equal(isLoopbackDatabaseHost(host), true, host);
  }
  assert.equal(isLoopbackDatabaseHost("10.0.0.5"), false);
  assert.equal(isLoopbackDatabaseHost("db.internal"), false);

  assert.doesNotThrow(() => assertSecureDatabaseTransport(
    "mariadb://brainvault:strong-secret@127.0.0.1:3306/brainvault",
    { production: true }
  ));
});

test("database URL query parameters fail closed instead of being silently ignored", () => {
  assert.throws(
    () => parseDatabaseUrl("mariadb://u:p@db.example/brainvault?ssl=true&ssl=false", { requireDatabase: true }),
    /must not repeat the ssl query parameter/
  );
  assert.throws(
    () => parseDatabaseUrl("mariadb://u:p@db.example/brainvault?ssl=1", { requireDatabase: true }),
    /must be true or false/
  );
  assert.throws(
    () => parseDatabaseUrl("mariadb://u:p@db.example/brainvault?tls=true", { requireDatabase: true }),
    /unsupported query parameter/
  );
});
