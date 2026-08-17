import { BLOCK_MARKDOWN_MAX_LENGTH } from "./editor-content-limits.js";
import { t } from "./i18n.js";

const languageDefinitions = [
  { id: "plaintext", label: "Plain text", grammar: "plaintext", aliases: ["text", "txt", "none"] },
  { id: "c", label: "C", grammar: "c", aliases: [] },
  { id: "cpp", label: "C++", grammar: "cpp", aliases: ["c++", "cc", "cxx"] },
  { id: "csharp", label: "C#", grammar: "csharp", aliases: ["c#", "cs", "dotnet"] },
  { id: "java", label: "Java", grammar: "java", aliases: [] },
  { id: "python", label: "Python", grammar: "python", aliases: ["py"] },
  { id: "dart", label: "Dart", grammar: "dart", aliases: ["dartlang"] },
  { id: "rust", label: "Rust", grammar: "rust", aliases: ["rs"] },
  { id: "lua", label: "Lua", grammar: "lua", aliases: [] },
  { id: "ruby", label: "Ruby", grammar: "ruby", aliases: ["rb"] },
  { id: "perl", label: "Perl", grammar: "perl", aliases: ["pl"] },
  { id: "bash", label: "Bash", grammar: "bash", aliases: ["sh", "shell", "zsh"] },
  { id: "powershell", label: "PowerShell", grammar: "powershell", aliases: ["pwsh", "ps1"] },
  { id: "json", label: "JSON", grammar: "json", aliases: [] },
  { id: "ini", label: "INI", grammar: "ini", aliases: [] },
  { id: "sql", label: "SQL", grammar: "sql", aliases: [] },
  { id: "xml", label: "XML", grammar: "xml", aliases: [] },
  { id: "yaml", label: "YAML", grammar: "yaml", aliases: ["yml"] },
  { id: "markdown", label: "Markdown", grammar: "markdown", aliases: ["md"] },
  { id: "html", label: "HTML", grammar: "xml", aliases: ["htm"] },
  { id: "javascript", label: "JavaScript", grammar: "javascript", aliases: ["js", "jsx", "node"] },
  { id: "css", label: "CSS", grammar: "css", aliases: [] },
  { id: "php", label: "PHP", grammar: "php", aliases: [] },
  { id: "vbnet", label: "VB.NET", grammar: "vbnet", aliases: ["vb", "vb.net"] },
  { id: "basic", label: "BASIC", grammar: "basic", aliases: ["qbasic"] },
  { id: "assembly", label: "Assembly", grammar: "x86asm", aliases: ["asm", "x86", "x86asm"] },
  { id: "delphi", label: "Delphi", grammar: "delphi", aliases: ["pascal", "objectpascal"] },
  { id: "lisp", label: "Lisp", grammar: "lisp", aliases: ["cl", "commonlisp", "elisp"] },
  { id: "typescript", label: "TypeScript", grammar: "typescript", aliases: ["ts", "tsx"] },
  { id: "coffeescript", label: "CoffeeScript", grammar: "coffeescript", aliases: ["coffee", "cson"] },
  { id: "cobol", label: "COBOL", grammar: "cobol", aliases: ["cob"] },
  { id: "fortran", label: "Fortran", grammar: "fortran", aliases: ["f90", "f95", "potran"] },
  { id: "matlab", label: "MATLAB", grammar: "matlab", aliases: ["octave"] },
  { id: "kotlin", label: "Kotlin", grammar: "kotlin", aliases: ["kt", "kts"] },
  { id: "objectivec", label: "Objective-C", grammar: "objectivec", aliases: ["objective-c", "objc", "obj-c"] },
  { id: "swift", label: "Swift", grammar: "swift", aliases: [] },
  { id: "haskell", label: "Haskell", grammar: "haskell", aliases: ["hs"] }
];

export const codeLanguageOptions = Object.freeze(languageDefinitions.map((definition) => Object.freeze({ ...definition })));

export const highlightResourceLimits = Object.freeze({
  maxSourceLength: 2_000,
  maxHydrationSourceLength: 8_000,
  maxHydratedBlocks: 20,
  maxLuaSourceLength: BLOCK_MARKDOWN_MAX_LENGTH,
  maxLuaHydrationSourceLength: BLOCK_MARKDOWN_MAX_LENGTH * 2
});

const languageById = new Map();
for (const definition of codeLanguageOptions) {
  for (const alias of [definition.id, definition.grammar, ...definition.aliases]) {
    const normalizedAlias = String(alias).trim().toLowerCase();
    if (!languageById.has(normalizedAlias)) languageById.set(normalizedAlias, definition);
  }
}

export function normalizeCodeLanguage(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return languageById.get(normalized)?.id ?? "plaintext";
}

export function getCodeLanguageDefinition(value) {
  return languageById.get(normalizeCodeLanguage(value)) ?? codeLanguageOptions[0];
}

function getMetadataRecord(metadata) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) return metadata;
  if (typeof metadata !== "string") return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getBlockCodeLanguage(block) {
  return normalizeCodeLanguage(getMetadataRecord(block?.metadata).codeLanguage);
}

export function stripCodeFence(value) {
  return String(value ?? "")
    .replace(/^\s*```[^\n]*\n?/, "")
    .replace(/\n?```\s*$/, "");
}

const luaKeywords = new Set(
  "and break do else elseif end for function goto if in local not or repeat return then until while".split(" ")
);
const luaLiterals = new Set(["true", "false", "nil"]);
const luaBuiltIns = new Set(
  (
    "_G _VERSION assert collectgarbage dofile error getmetatable ipairs load loadfile next pairs pcall print " +
    "rawequal rawget rawlen rawset require select setmetatable tonumber tostring type warn xpcall coroutine debug io " +
    "math os package string table utf8"
  ).split(" ")
);

function escapeHighlightedHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function wrapHighlightedToken(scope, value) {
  return `<span class="hljs-${scope}">${escapeHighlightedHtml(value)}</span>`;
}

function getLuaLongBracketEnd(source, start) {
  if (source[start] !== "[") return null;
  let cursor = start + 1;
  while (source[cursor] === "=") cursor += 1;
  if (source[cursor] !== "[") return null;
  const equals = source.slice(start + 1, cursor);
  const closing = `]${equals}]`;
  const closingIndex = source.indexOf(closing, cursor + 1);
  return closingIndex === -1 ? source.length : closingIndex + closing.length;
}

function getLuaQuotedStringEnd(source, start) {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return source.length;
}

const luaHexNumberPattern = /0[xX](?:[0-9a-fA-F]+(?:\.(?!\.)[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?/y;
const luaDecimalNumberPattern = /(?:\d+(?:\.(?!\.)\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

function getLuaNumberLength(source, start) {
  luaHexNumberPattern.lastIndex = start;
  const hex = luaHexNumberPattern.exec(source);
  if (hex) return hex[0].length;
  luaDecimalNumberPattern.lastIndex = start;
  return luaDecimalNumberPattern.exec(source)?.[0]?.length ?? 0;
}

export function highlightLuaSource(value) {
  const source = String(value ?? "");
  if (source.length > highlightResourceLimits.maxLuaSourceLength) return null;

  const output = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("--", cursor)) {
      const longCommentEnd = getLuaLongBracketEnd(source, cursor + 2);
      if (longCommentEnd !== null) {
        output.push(wrapHighlightedToken("comment", source.slice(cursor, longCommentEnd)));
        cursor = longCommentEnd;
        continue;
      }
      const lineEnd = source.indexOf("\n", cursor + 2);
      const end = lineEnd === -1 ? source.length : lineEnd;
      output.push(wrapHighlightedToken("comment", source.slice(cursor, end)));
      cursor = end;
      continue;
    }

    const current = source[cursor];
    if (current === "\"" || current === "'") {
      const end = getLuaQuotedStringEnd(source, cursor);
      output.push(wrapHighlightedToken("string", source.slice(cursor, end)));
      cursor = end;
      continue;
    }

    if (current === "[") {
      const longStringEnd = getLuaLongBracketEnd(source, cursor);
      if (longStringEnd !== null) {
        output.push(wrapHighlightedToken("string", source.slice(cursor, longStringEnd)));
        cursor = longStringEnd;
        continue;
      }
    }

    const numberLength = (current >= "0" && current <= "9") || (current === "." && source[cursor - 1] !== "." && /\d/.test(source[cursor + 1] ?? ""))
      ? getLuaNumberLength(source, cursor)
      : 0;
    if (numberLength > 0) {
      output.push(wrapHighlightedToken("number", source.slice(cursor, cursor + numberLength)));
      cursor += numberLength;
      continue;
    }

    if (/[A-Za-z_]/.test(current)) {
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      const identifier = source.slice(cursor, end);
      if (luaKeywords.has(identifier)) output.push(wrapHighlightedToken("keyword", identifier));
      else if (luaLiterals.has(identifier)) output.push(wrapHighlightedToken("literal", identifier));
      else if (luaBuiltIns.has(identifier)) output.push(wrapHighlightedToken("built_in", identifier));
      else output.push(escapeHighlightedHtml(identifier));
      cursor = end;
      continue;
    }

    output.push(escapeHighlightedHtml(current));
    cursor += 1;
  }

  return output.join("");
}

function highlightSource(source, definition) {
  if (definition.grammar === "plaintext") return null;
  // Lua code blocks can legally be as large as the editor's 20k character limit.
  // The generic Highlight.js regex grammars stay capped at 2k for synchronous
  // resource safety; Lua uses a small linear-time lexer so long scripts do not
  // silently lose all syntax highlighting.
  if (definition.grammar === "lua") return highlightLuaSource(source);
  if (source.length > highlightResourceLimits.maxSourceLength) return null;
  const highlighter = globalThis.hljs;
  if (!highlighter?.highlight || !highlighter.getLanguage?.(definition.grammar)) return null;
  try {
    return highlighter.highlight(source, {
      language: definition.grammar,
      ignoreIllegals: true
    }).value;
  } catch (error) {
    console.warn(`Syntax highlighting failed for ${definition.id}`, error);
    return null;
  }
}

export function highlightCodeForBrowser(value, language) {
  const definition = getCodeLanguageDefinition(language);
  return highlightSource(stripCodeFence(value), definition);
}

function createHighlightedCodeElement(source, definition) {
  const pre = document.createElement("pre");
  pre.className = "rendered-code-pre";
  const code = document.createElement("code");
  code.className = `hljs language-${definition.grammar}`;
  const highlighted = highlightSource(source, definition);
  if (highlighted === null) code.textContent = source;
  else code.innerHTML = highlighted;
  pre.append(code);
  return pre;
}

async function copyTextToClipboard(value) {
  const text = String(value ?? "");
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall back for non-secure contexts or browsers that deny Clipboard API access.
    }
  }

  const doc = globalThis.document;
  if (!doc?.body || typeof doc.execCommand !== "function") return false;
  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  doc.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return Boolean(doc.execCommand("copy"));
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function setCopyButtonMessage(button, label, key) {
  const message = t(key);
  label.textContent = message;
  button.title = message;
  button.setAttribute("aria-label", message);
  button.classList.toggle("is-copied", key === "block.codeCopied");
  button.classList.toggle("is-copy-error", key === "block.codeCopyFailed");
}

function createAiAnswerCodeCopyButton(code) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rendered-code-copy-button";
  button.dataset.action = "copy-ai-answer-code";
  button.dataset.i18nAriaLabel = "block.copyCode";
  button.dataset.i18nTitle = "block.copyCode";

  const label = document.createElement("span");
  label.className = "rendered-code-copy-label";
  label.dataset.i18n = "block.copyCode";
  setCopyButtonMessage(button, label, "block.copyCode");
  button.append(label);

  let resetTimer = null;
  button.addEventListener("click", async () => {
    if (resetTimer !== null) globalThis.clearTimeout(resetTimer);
    const copied = await copyTextToClipboard(code.textContent ?? "");
    setCopyButtonMessage(button, label, copied ? "block.codeCopied" : "block.codeCopyFailed");
    resetTimer = globalThis.setTimeout(() => {
      resetTimer = null;
      if (button.isConnected) setCopyButtonMessage(button, label, "block.copyCode");
    }, copied ? 1600 : 2200);
  });
  return button;
}

function hydrateAiAnswerCodeCopyButtons(root) {
  for (const pre of root.querySelectorAll(".rendered-ai-chat-answer .rendered-code-pre")) {
    if (pre.closest(".rendered-code-copy-shell")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;

    const shell = document.createElement("div");
    shell.className = "rendered-code-copy-shell";
    pre.before(shell);
    shell.append(pre, createAiAnswerCodeCopyButton(code));
  }
}

export function renderCodePreview(preview, value, language) {
  if (!preview) return;
  const definition = getCodeLanguageDefinition(language);
  const source = stripCodeFence(value);
  const shell = document.createElement("div");
  shell.className = "rendered-code-shell";
  const header = document.createElement("div");
  header.className = "rendered-code-header";
  const badge = document.createElement("span");
  badge.className = "rendered-code-language";
  badge.textContent = definition.label;
  header.append(badge);
  shell.append(header, createHighlightedCodeElement(source, definition));
  preview.replaceChildren(shell);
}

export function hydrateHighlightedCodeBlocks(root = document) {
  let attemptedBlocks = 0;
  let attemptedSourceLength = 0;
  let attemptedLuaSourceLength = 0;

  for (const code of root.querySelectorAll("pre > code[class*='language-']:not(.hljs)")) {
    const className = [...code.classList].find((name) => name.startsWith("language-"));
    const definition = getCodeLanguageDefinition(className?.slice("language-".length));
    const source = code.textContent ?? "";
    const isLua = definition.grammar === "lua";
    const withinHydrationBudget =
      attemptedBlocks < highlightResourceLimits.maxHydratedBlocks &&
      (isLua
        ? attemptedLuaSourceLength + source.length <= highlightResourceLimits.maxLuaHydrationSourceLength
        : attemptedSourceLength + source.length <= highlightResourceLimits.maxHydrationSourceLength);
    let highlighted = null;
    if (withinHydrationBudget) {
      attemptedBlocks += 1;
      if (isLua) attemptedLuaSourceLength += source.length;
      else attemptedSourceLength += source.length;
      highlighted = highlightSource(source, definition);
    }
    code.classList.add("hljs", `language-${definition.grammar}`);
    if (highlighted !== null) code.innerHTML = highlighted;
  }

  hydrateAiAnswerCodeCopyButtons(root);
}
