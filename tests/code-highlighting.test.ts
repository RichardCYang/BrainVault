import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  codeLanguageDefinitions,
  getCodeLanguage,
  getHighlightJsVersion,
  highlightCode,
  normalizeCodeLanguage,
  renderHighlightedCode
} from "../src/lib/code-highlighting.js";
import { renderBlockHtml, renderMarkdown } from "../src/lib/markdown.js";

const samples: Record<string, string> = {
  plaintext: "plain text",
  c: "int main(void) { return 0; }",
  cpp: "#include <vector>\nint main() { return 0; }",
  csharp: "public class App { static void Main() {} }",
  java: "class App { public static void main(String[] args) {} }",
  python: "def hello(name):\n    return f\"Hi {name}\"",
  dart: "void main() => print('Hi');",
  rust: "fn main() { println!(\"Hi\"); }",
  lua: "local function hello() return true end",
  ruby: "def hello(name)\n  puts name\nend",
  perl: "my $name = 'BrainVault';",
  bash: "#!/usr/bin/env bash\necho \"$HOME\"",
  powershell: "$items | Where-Object { $_.Enabled }",
  json: '{"ok": true}',
  sql: "SELECT * FROM notes WHERE archived = FALSE;",
  xml: '<note id="1">Hello</note>',
  yaml: "note:\n  archived: false",
  markdown: "# Heading\n\n`code`",
  html: "<main><h1>Hello</h1></main>",
  javascript: "const answer = () => 42;",
  css: ".note { display: grid; }",
  php: "<?php echo 'Hello'; ?>",
  vbnet: "Public Class App\nEnd Class",
  basic: '10 PRINT "HELLO"',
  assembly: "mov eax, 1\nret",
  delphi: "program Hello; begin WriteLn('Hi'); end.",
  lisp: '(defun hello () (print "Hi"))',
  typescript: "const answer: number = 42;",
  coffeescript: "square = (x) -> x * x",
  cobol: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO.",
  fortran: 'program hello\n print *, "Hi"\nend program hello',
  matlab: "x = linspace(0, 1, 10);\nplot(x);",
  kotlin: 'fun main() = println("Hi")',
  objectivec: "@interface App : NSObject\n@end",
  swift: 'func hello() -> String { "Hi" }',
  haskell: 'main :: IO ()\nmain = putStrLn "Hi"'
};

describe("syntax highlighting", () => {
  it("normalizes language names and BrainVault aliases", () => {
    expect(normalizeCodeLanguage("C++")).toBe("cpp");
    expect(normalizeCodeLanguage("C#")).toBe("csharp");
    expect(normalizeCodeLanguage("VB")).toBe("vbnet");
    expect(normalizeCodeLanguage("POTRAN")).toBe("fortran");
    expect(normalizeCodeLanguage("objective-c")).toBe("objectivec");
    expect(normalizeCodeLanguage("xml")).toBe("xml");
    expect(getCodeLanguage('{"codeLanguage":"TS"}')).toBe("typescript");
  });

  it("loads every language exposed by the code-block selector", () => {
    expect(getHighlightJsVersion()).not.toBe("unknown");
    expect(Object.keys(samples)).toHaveLength(codeLanguageDefinitions.length);

    for (const definition of codeLanguageDefinitions) {
      const result = highlightCode(samples[definition.id], definition.id);
      expect(result.definition.id).toBe(definition.id);
      expect(result.html.length).toBeGreaterThan(0);
    }
  });

  it("escapes source code before returning highlighted HTML", () => {
    const html = renderHighlightedCode("<script>alert(1)</script>", "html");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
    expect(html).toContain("language-xml");
  });

  it("renders a persisted CODE block with its selected language", () => {
    const html = renderBlockHtml("CODE", "const answer = 42;", false, { codeLanguage: "javascript" });
    expect(html).toContain("rendered-code-shell");
    expect(html).toContain("language-javascript");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("JavaScript");
  });

  it("highlights fenced code inside Markdown", () => {
    const html = renderMarkdown("```python\ndef hello():\n    return True\n```");
    expect(html).toContain("language-python");
    expect(html).toContain("hljs-keyword");
  });

  it("loads all highlighting assets locally before the app module", () => {
    const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const highlighterIndex = index.indexOf('/vendor/highlight/highlight.min.js');
    const supplementalIndex = index.indexOf('/vendor/highlight/brainvault-languages.js');
    const appIndex = index.indexOf('type="module" src="/app.js"');
    expect(highlighterIndex).toBeGreaterThan(-1);
    expect(supplementalIndex).toBeGreaterThan(highlighterIndex);
    expect(appIndex).toBeGreaterThan(supplementalIndex);
  });
});
