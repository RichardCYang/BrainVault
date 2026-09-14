import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { syncAiChatTextareaHeights } from "../public/ai-chat-block.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function createTextarea({ question = false, scrollHeight = 0, visible = false } = {}) {
  const style = {
    height: "",
    removeProperty(name) {
      if (name === "height") this.height = "";
    }
  };

  return {
    classList: {
      contains(name) {
        return question && name === "ai-chat-question-input";
      }
    },
    getClientRects() {
      return visible ? [{}] : [];
    },
    scrollHeight,
    style
  };
}

test("AI textarea sizing defers hidden read-mode measurement and expands after write mode becomes visible", () => {
  const answer = createTextarea({ scrollHeight: 486, visible: false });
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, ".ai-chat-question-input, .ai-chat-answer-input");
      return [answer];
    }
  };

  syncAiChatTextareaHeights(root);
  assert.equal(answer.style.height, "", "hidden editors must not freeze a minimum inline height");

  answer.getClientRects = () => [{}];
  syncAiChatTextareaHeights(root);
  assert.equal(answer.style.height, "486px", "visible editors must expand to their content scrollHeight");
});

test("AI textarea sizing preserves the existing question and answer minimum heights", () => {
  const question = createTextarea({ question: true, scrollHeight: 12, visible: true });
  const answer = createTextarea({ scrollHeight: 18, visible: true });
  const root = { querySelectorAll: () => [question, answer] };

  syncAiChatTextareaHeights(root);

  assert.equal(question.style.height, "38px");
  assert.equal(answer.style.height, "112px");
});

test("native AI textarea sizing removes stale inline heights without reading or collapsing the live control", () => {
  const previousCss = globalThis.CSS;
  const answer = createTextarea({ scrollHeight: 486, visible: true });
  answer.style.height = "486px";
  Object.defineProperty(answer, "scrollHeight", {
    get() {
      throw new Error("native field sizing must not read scrollHeight during typing");
    }
  });

  globalThis.CSS = { supports: (property, value) => property === "field-sizing" && value === "content" };
  try {
    syncAiChatTextareaHeights({ querySelectorAll: () => [answer] });
    assert.equal(answer.style.height, "");
  } finally {
    if (previousCss === undefined) delete globalThis.CSS;
    else globalThis.CSS = previousCss;
  }
});

test("legacy AI textarea sizing never collapses the focused textarea to an intermediate auto height", () => {
  const previousCss = globalThis.CSS;
  const assignments = [];
  const answer = createTextarea({ scrollHeight: 486, visible: true });
  let liveHeight = "486px";
  Object.defineProperty(answer.style, "height", {
    configurable: true,
    get() {
      return liveHeight;
    },
    set(value) {
      liveHeight = value;
      assignments.push(value);
    }
  });

  globalThis.CSS = { supports: () => false };
  try {
    syncAiChatTextareaHeights({ querySelectorAll: () => [answer] });
    assert.deepEqual(assignments, ["486px"]);
    assert.equal(assignments.includes("auto"), false);
  } finally {
    if (previousCss === undefined) delete globalThis.CSS;
    else globalThis.CSS = previousCss;
  }
});

test("write-mode UI synchronization re-measures mounted AI textarea heights after layout is restored", () => {
  assert.match(appSource, /syncAiChatTextareaHeights,/);
  assert.match(
    appSource,
    /requestAnimationFrame\(\(\) => \{[\s\S]*if \(!isPageReadOnly\(\)\) syncAiChatTextareaHeights\(elements\.pageView\);/
  );
});
