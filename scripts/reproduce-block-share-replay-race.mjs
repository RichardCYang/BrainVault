function simulatePatchReplay({ fixed, exactReplay }) {
  const storedMutationId = "mut-1";
  const incomingMutationId = "mut-1";
  const storedHash = "hash-a";
  const incomingHash = exactReplay ? "hash-a" : "hash-b";
  const shareCount = 1;
  let writes = 0;

  const isReplay = () => {
    if (storedMutationId !== incomingMutationId) return false;
    if (storedHash !== incomingHash) return "collision";
    return true;
  };
  const directAllowed = () => shareCount === 0;

  if (!fixed && !directAllowed()) {
    return { outcome: "COLLABORATION_REQUIRED", writes };
  }

  const replay = isReplay();
  if (replay === "collision") {
    return { outcome: "MUTATION_ID_REUSED", writes };
  }
  if (replay === true) {
    return { outcome: "REPLAYED", writes };
  }

  if (fixed && !directAllowed()) {
    return { outcome: "COLLABORATION_REQUIRED", writes };
  }

  writes += 1;
  return { outcome: "WRITTEN", writes };
}

console.log(JSON.stringify({
  exactReplay: {
    vulnerable: simulatePatchReplay({ fixed: false, exactReplay: true }),
    fixed: simulatePatchReplay({ fixed: true, exactReplay: true })
  },
  collision: {
    vulnerable: simulatePatchReplay({ fixed: false, exactReplay: false }),
    fixed: simulatePatchReplay({ fixed: true, exactReplay: false })
  }
}, null, 2));
