import assert from "node:assert/strict";

function sortedLockOrder(userIds) {
  return [...new Set(userIds)].sort();
}

function reciprocalRace(firstActor, firstOther, secondActor, secondOther) {
  const vulnerableFirst = [firstActor, firstOther];
  const vulnerableSecond = [secondActor, secondOther];
  const fixedFirst = sortedLockOrder(vulnerableFirst);
  const fixedSecond = sortedLockOrder(vulnerableSecond);

  return {
    vulnerable: {
      first: vulnerableFirst,
      second: vulnerableSecond,
      cycleRisk: vulnerableFirst[0] === vulnerableSecond[1]
        && vulnerableFirst[1] === vulnerableSecond[0]
    },
    fixed: {
      first: fixedFirst,
      second: fixedSecond,
      cycleRisk: fixedFirst[0] === fixedSecond[1]
        && fixedFirst[1] === fixedSecond[0]
    }
  };
}

const report = {
  delegatedPageCreate: reciprocalRace(
    "usr_admin_a", "usr_owner_b", "usr_owner_b", "usr_admin_a"
  ),
  delegatedCollectionShare: reciprocalRace(
    "usr_admin_a", "usr_owner_b", "usr_owner_b", "usr_admin_a"
  ),
  directShareTargetForeignKey: reciprocalRace(
    "usr_owner_a", "usr_owner_b", "usr_owner_b", "usr_owner_a"
  )
};

for (const race of Object.values(report)) {
  assert.equal(race.vulnerable.cycleRisk, true);
  assert.equal(race.fixed.cycleRisk, false);
  assert.deepEqual(race.fixed.first, race.fixed.second);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
