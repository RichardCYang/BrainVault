import { planCollaborativeBlockReplacement } from "../public/collaboration.js";

function block(id, parentBlockId, sortOrder, type = "MARKDOWN") {
  return {
    id,
    type,
    markdown: type === "ATTACHMENT" ? `${id}.txt` : "",
    checked: false,
    parentBlockId,
    sortOrder,
    metadata: type === "ATTACHMENT"
      ? { attachment: { originalName: `${id}.txt`, mimeType: "text/plain", size: 1 } }
      : null
  };
}

const before = block("before", null, 0);
const source = block("target", null, 1);
const after = block("after", null, 2);
const attachment = block("attachment", null, 1, "ATTACHMENT");
const peerChild = block("peer-child", "target", 0);
const currentSnapshot = [before, source, peerChild, after, attachment];

const vulnerablePlan = planCollaborativeBlockReplacement(
  currentSnapshot,
  "target",
  attachment,
  {
    expectedSourceBlock: source,
    expectedReplacementBlock: attachment
  }
);

const expectedPromoteStructure = [before, source, after]
  .map(({ id, parentBlockId, sortOrder }) => ({ id, parentBlockId, sortOrder }));
const fixedPlan = planCollaborativeBlockReplacement(
  currentSnapshot,
  "target",
  attachment,
  {
    expectedSourceBlock: source,
    expectedReplacementBlock: attachment,
    expectedPromoteStructure
  }
);

process.stdout.write(`${JSON.stringify({
  vulnerable: {
    replacementWouldApply: Boolean(vulnerablePlan),
    peerChildAfterReplacement: vulnerablePlan?.updates.find((item) => item.id === "peer-child") ?? null
  },
  fixed: {
    replacementWouldApply: Boolean(fixedPlan),
    peerChildPreservedUnderSource: fixedPlan === null
  }
}, null, 2)}\n`);
