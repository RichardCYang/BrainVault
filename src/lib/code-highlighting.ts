import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export type CodeLanguageDefinition = Readonly<{
  id: string;
  label: string;
  grammar: string;
  aliases: readonly string[];
}>;

export const codeLanguageDefinitions: readonly CodeLanguageDefinition[] = Object.freeze([
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
].map((definition) => Object.freeze({ ...definition, aliases: Object.freeze([...definition.aliases]) })));

const languageByAlias = new Map<string, CodeLanguageDefinition>();
for (const definition of codeLanguageDefinitions) {
  for (const alias of [definition.id, definition.grammar, ...definition.aliases]) {
    const normalizedAlias = alias.trim().toLowerCase();
    if (!languageByAlias.has(normalizedAlias)) languageByAlias.set(normalizedAlias, definition);
  }
}

interface HighlightResult {
  value: string;
}

interface HighlightJsRuntime {
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): HighlightResult;
  getLanguage(name: string): unknown;
  listLanguages(): string[];
  versionString?: string;
}

export const highlightResourceLimits = Object.freeze({
  maxSourceLength: 2_000,
  executionTimeoutMs: 25
});

type HighlightVmContext = ReturnType<typeof vm.createContext> & {
  hljs?: HighlightJsRuntime;
  __brainvaultSource?: string;
  __brainvaultLanguage?: string;
};

type HighlightRuntime = Readonly<{
  context: HighlightVmContext;
  highlighter: HighlightJsRuntime;
  script: vm.Script;
}>;

let cachedHighlightRuntime: HighlightRuntime | null = null;

function getVendorPath(...segments: string[]) {
  return path.resolve(process.cwd(), "public", "vendor", "highlight", ...segments);
}

function loadHighlightJs() {
  if (cachedHighlightRuntime) return cachedHighlightRuntime;

  const context = vm.createContext({ console }) as HighlightVmContext;
  for (const filename of ["highlight.min.js", "brainvault-languages.js"]) {
    const source = fs.readFileSync(getVendorPath(filename), "utf8");
    vm.runInContext(source, context, { filename: getVendorPath(filename) });
  }

  const highlighter = context.hljs;
  if (!highlighter?.highlight || !highlighter.getLanguage) {
    throw new Error("Highlight.js failed to initialize from the vendored assets.");
  }

  const missing = [...new Set(codeLanguageDefinitions.map(({ grammar }) => grammar))]
    .filter((grammar) => !highlighter.getLanguage(grammar));
  if (missing.length) {
    throw new Error(`Highlight.js grammars are missing: ${missing.join(", ")}`);
  }

  const script = new vm.Script(
    "hljs.highlight(__brainvaultSource, { language: __brainvaultLanguage, ignoreIllegals: true }).value",
    { filename: getVendorPath("brainvault-highlight-runner.vm.js") }
  );
  cachedHighlightRuntime = Object.freeze({ context, highlighter, script });
  return cachedHighlightRuntime;
}

function runHighlightWithDeadline(source: string, grammar: string) {
  const runtime = loadHighlightJs();
  runtime.context.__brainvaultSource = source;
  runtime.context.__brainvaultLanguage = grammar;
  try {
    const value = runtime.script.runInContext(runtime.context, {
      timeout: highlightResourceLimits.executionTimeoutMs
    }) as unknown;
    if (typeof value !== "string") throw new Error("Highlight.js returned an invalid result.");
    return value;
  } finally {
    delete runtime.context.__brainvaultSource;
    delete runtime.context.__brainvaultLanguage;
  }
}

function getMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata !== "string") return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function normalizeCodeLanguage(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return languageByAlias.get(normalized)?.id ?? "plaintext";
}

export function getCodeLanguageDefinition(value: unknown) {
  return languageByAlias.get(normalizeCodeLanguage(value)) ?? codeLanguageDefinitions[0];
}

export function getCodeLanguage(metadata: unknown) {
  return normalizeCodeLanguage(getMetadataRecord(metadata).codeLanguage);
}

export function stripCodeFence(value: unknown) {
  return String(value ?? "")
    .replace(/^\s*```[^\n]*\n?/, "")
    .replace(/\n?```\s*$/, "");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function highlightCode(value: unknown, language: unknown) {
  const definition = getCodeLanguageDefinition(language);
  const source = stripCodeFence(value);
  const fallback = () => ({ definition, source, html: escapeHtml(source) });

  // Highlight.js grammars execute complex regular expressions synchronously. Keep
  // untrusted note content below a small input ceiling and a VM execution deadline.
  if (definition.grammar === "plaintext" || source.length > highlightResourceLimits.maxSourceLength) {
    return fallback();
  }

  try {
    return { definition, source, html: runHighlightWithDeadline(source, definition.grammar) };
  } catch {
    return fallback();
  }
}

export function renderHighlightedCode(value: unknown, language: unknown, { showLanguage = true } = {}) {
  const highlighted = highlightCode(value, language);
  const label = escapeHtml(highlighted.definition.label);
  const header = showLanguage
    ? `<div class="rendered-code-header"><span class="rendered-code-language">${label}</span></div>`
    : "";
  return `<div class="rendered-code-shell">${header}<pre class="rendered-code-pre"><code class="hljs language-${highlighted.definition.grammar}">${highlighted.html}</code></pre></div>`;
}

export function renderMarkdownCodeFence(value: unknown, language: unknown) {
  const highlighted = highlightCode(value, language);
  return `<pre class="rendered-code-pre"><code class="hljs language-${highlighted.definition.grammar}">${highlighted.html}</code></pre>`;
}

export function getHighlightJsVersion() {
  return loadHighlightJs().highlighter.versionString ?? "unknown";
}
