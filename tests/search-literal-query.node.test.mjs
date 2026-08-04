import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  escapeSqlLikeLiteral,
  toSqlLikeContainsPattern
} from "../src/lib/sql-like.ts";

const REGEXP_SPECIAL_CHARACTERS = "\\^$.*+?()[]{}|";

function escapeRegExpCharacter(character) {
  return REGEXP_SPECIAL_CHARACTERS.includes(character) ? `\\${character}` : character;
}

function sqlLikeMatches(value, pattern, escapeCharacter = "!") {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === escapeCharacter) {
      index += 1;
      if (index >= pattern.length) return false;
      source += escapeRegExpCharacter(pattern[index]);
      continue;
    }
    if (character === "%") {
      source += "[\\s\\S]*";
    } else if (character === "_") {
      source += "[\\s\\S]";
    } else {
      source += escapeRegExpCharacter(character);
    }
  }
  source += "$";
  return new RegExp(source, "u").test(value);
}

const readSource = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("the previous contains pattern treats literal percent and underscore as wildcards", () => {
  assert.equal(sqlLikeMatches("budget 100abc complete", "%100%%"), true);
  assert.equal(sqlLikeMatches("any nonempty title", "%_%"), true);
});

test("literal LIKE escaping preserves contains-search semantics", () => {
  assert.equal(escapeSqlLikeLiteral("release! 100%_done"), "release!! 100!%!_done");
  assert.equal(toSqlLikeContainsPattern("100%"), "%100!%%");
  assert.equal(toSqlLikeContainsPattern("_"), "%!_%");

  assert.equal(sqlLikeMatches("budget 100% complete", toSqlLikeContainsPattern("100%")), true);
  assert.equal(sqlLikeMatches("budget 100abc complete", toSqlLikeContainsPattern("100%")), false);
  assert.equal(sqlLikeMatches("snake_case", toSqlLikeContainsPattern("_")), true);
  assert.equal(sqlLikeMatches("snake case", toSqlLikeContainsPattern("_")), false);
  assert.equal(sqlLikeMatches("attention!", toSqlLikeContainsPattern("!")), true);
});

test("both server search paths bind escaped patterns and declare the same escape character", async () => {
  const [searchRoute, pageRoute] = await Promise.all([
    readSource("src/routes/search.routes.ts"),
    readSource("src/routes/page.routes.ts")
  ]);

  assert.match(searchRoute, /const search = toSqlLikeContainsPattern\(query\.q\);/);
  assert.equal((searchRoute.match(/LIKE \? ESCAPE '!'/g) ?? []).length, 2);
  assert.doesNotMatch(searchRoute, /const search = `%\$\{query\.q\}%`/);

  assert.match(pageRoute, /const search = toSqlLikeContainsPattern\(query\.q\);/);
  assert.equal((pageRoute.match(/LIKE \? ESCAPE '!'/g) ?? []).length, 2);
  assert.doesNotMatch(pageRoute, /whereParams\.push\(`%\$\{query\.q\}%`/);
});
