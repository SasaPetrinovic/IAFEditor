const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const LANGUAGE = "iaf";

const blockPairs = new Map([
  ["PROCEDURE", "END_PROCEDURE"],
  ["IF", "END_IF"],
  ["DO_WHILE", "END_DO"],
  ["SELECT_ALL", "END_SELECT"],
  ["READ_ALL", "END_READ"]
]);

const closingToOpening = new Map(
  Array.from(blockPairs.entries()).map(([opening, closing]) => [closing, opening])
);

const middleKeywords = new Set(["ELSE", "ELSE_IF"]);

const fallbackKeywords = [
  "IF", "ELSE_IF", "ELSE", "END_IF", "DO_WHILE", "END_DO", "SELECT_ALL", "END_SELECT",
  "EXECSQL", "READ", "WRITE", "UPDATE", "DELETE", "APPEND", "COMMIT", "ROLLBACK",
  "PAUSE", "CHECK", "ERRMSG", "BREAK", "CONTINUE", "RETURN", "FOUND", "RECORD"
];

const contextualKeywords = new Set([
  "AND", "AS", "BY", "CASE", "CREATE", "DROP", "ELSE", "END", "FROM", "GROUP",
  "HAVING", "IN", "INNER", "INSERT", "INTO", "JOIN", "LEFT", "LIKE", "NOT", "OR",
  "ORDER", "OUTER", "RIGHT", "SELECT", "SET", "THEN", "TO", "VALUES", "WHEN",
  "WHERE"
]);

let diagnostics;
let helpIndex = [];
let helpByName = new Map();
let blockTreeProvider;
let extensionContext;
let helpPanel;

function activate(context) {
  extensionContext = context;
  helpIndex = loadHelpIndex(context.extensionPath);
  helpByName = new Map(helpIndex.map((item) => [item.name.toUpperCase(), item]));

  diagnostics = vscode.languages.createDiagnosticCollection("iaf");
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    LANGUAGE,
    new IafCompletionProvider(),
    "$"
  ));

  context.subscriptions.push(vscode.languages.registerHoverProvider(
    LANGUAGE,
    new IafHoverProvider()
  ));

  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(
    LANGUAGE,
    new IafFoldingProvider()
  ));

  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    LANGUAGE,
    new IafFormattingProvider()
  ));

  blockTreeProvider = new IafBlockTreeProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("iafBlockTree", blockTreeProvider));

  context.subscriptions.push(vscode.commands.registerCommand("iaf.openHelp", () => openHelpForWord()));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.searchHelp", () => searchHelp()));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.openHelpContents", () => openHelpContents()));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.showBlockTree", () => showBlockTree()));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.addEndComments", () => addEndComments()));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.exportHtml", () => exportHtml()));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.goToBlock", (item) => goToBlock(item)));
  context.subscriptions.push(vscode.commands.registerCommand("iaf.validateBlocks", () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === LANGUAGE) {
      updateDiagnostics(editor.document);
      vscode.window.showInformationMessage("IAF block validation finished.");
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(updateDiagnostics));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    updateDiagnostics(event.document);
    if (event.document.languageId === LANGUAGE) {
      blockTreeProvider.refresh();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => {
    diagnostics.delete(document.uri);
    blockTreeProvider.refresh();
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => blockTreeProvider.refresh()));

  for (const document of vscode.workspace.textDocuments) {
    updateDiagnostics(document);
  }
}

function deactivate() {
  if (diagnostics) {
    diagnostics.dispose();
  }
}

class IafCompletionProvider {
  provideCompletionItems() {
    const items = [];
    const source = helpIndex.length ? helpIndex : fallbackKeywords.map((name) => ({ name }));

    for (const entry of source) {
      const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Keyword);
      const syntax = firstSyntax(entry);
      item.detail = syntax || "IAF";
      item.documentation = buildHelpMarkdown(entry, false);
      item.insertText = syntax ? new vscode.SnippetString(syntaxToSnippet(syntax)) : entry.name;
      items.push(item);
    }

    return items;
  }
}

class IafHoverProvider {
  provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position, /(?:\$?[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)/);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range).replace(/^\$/, "").toUpperCase();
    const entry = helpByName.get(word);
    if (!entry) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(buildHelpMarkdown(entry, true).value);
    markdown.appendMarkdown(`\n\n[Open IAF help](command:iaf.openHelp)`);
    markdown.isTrusted = true;
    return new vscode.Hover(markdown, range);
  }
}

class IafFoldingProvider {
  provideFoldingRanges(document) {
    const ranges = [];
    const stack = [];

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const text = stripComment(document.lineAt(lineNumber).text).trim();
      const keyword = firstKeyword(text);
      const lower = document.lineAt(lineNumber).text.trim().toLowerCase();

      if (/^!\s*#region\b/.test(lower)) {
        stack.push({ keyword: "REGION", line: lineNumber });
        continue;
      }

      if (/^!\s*#endregion\b/.test(lower)) {
        closeFoldingRange(stack, ranges, "REGION", lineNumber);
        continue;
      }

      if (blockPairs.has(keyword)) {
        stack.push({ keyword, line: lineNumber });
        continue;
      }

      if (closingToOpening.has(keyword)) {
        closeFoldingRange(stack, ranges, closingToOpening.get(keyword), lineNumber);
      }
    }

    return ranges;
  }
}

class IafFormattingProvider {
  provideDocumentFormattingEdits(document, options) {
    const edits = [];
    const indentUnit = options.insertSpaces === false ? "\t" : " ".repeat(options.tabSize || 4);
    let depth = 0;

    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const original = line.text;
      const trimmed = original.trim();
      const keyword = firstKeyword(stripComment(trimmed));

      if (trimmed.length === 0) {
        continue;
      }

      let lineDepth = depth;
      if (closingToOpening.has(keyword) || middleKeywords.has(keyword)) {
        lineDepth = Math.max(depth - 1, 0);
      }

      const formatted = indentUnit.repeat(lineDepth) + trimmed;
      if (formatted !== original) {
        edits.push(vscode.TextEdit.replace(line.range, formatted));
      }

      if (blockPairs.has(keyword)) {
        depth++;
      } else if (closingToOpening.has(keyword)) {
        depth = Math.max(depth - 1, 0);
      }
    }

    return edits;
  }
}

class IafBlockTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    const collapsibleState = element.children.length
      ? (element.keyword === "PROCEDURE" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(
      element.label,
      collapsibleState
    );
    item.description = element.children.length
      ? `L${element.lineNumber + 1}, ${element.children.length} blocks`
      : `L${element.lineNumber + 1}`;
    item.tooltip = `${element.text}\nLine ${element.lineNumber + 1}`;
    item.iconPath = new vscode.ThemeIcon(iconForKeyword(element.keyword));
    item.command = {
      command: "iaf.goToBlock",
      title: "Go to Block",
      arguments: [element]
    };
    return item;
  }

  getChildren(element) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== LANGUAGE) {
      return [];
    }

    if (element) {
      return element.children;
    }

    return buildBlockTree(editor.document).roots;
  }
}

function updateDiagnostics(document) {
  if (!diagnostics || document.languageId !== LANGUAGE) {
    return;
  }

  const problems = [];
  const stack = [];

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const line = document.lineAt(lineNumber);
    const code = stripComment(line.text).trim();
    const keyword = firstKeyword(code);

    if (!keyword) {
      continue;
    }

    if (shouldWarnUnknownKeyword(code, keyword)) {
      const suggestions = closestHelpNames(keyword, 3);
      const suffix = suggestions.length ? ` Did you mean ${suggestions.join(", ")}?` : "";
      problems.push(makeDiagnostic(
        line,
        `Unknown IAF keyword '${keyword}'.${suffix}`,
        vscode.DiagnosticSeverity.Warning
      ));
    }

    if (blockPairs.has(keyword)) {
      stack.push({ keyword, lineNumber, text: code });
      continue;
    }

    if (middleKeywords.has(keyword)) {
      const current = lastBlock(stack);
      if (!current || current.keyword !== "IF") {
        problems.push(makeDiagnostic(line, `${keyword} without matching IF.`, vscode.DiagnosticSeverity.Error));
      }
      continue;
    }

    if (closingToOpening.has(keyword)) {
      const expectedOpening = closingToOpening.get(keyword);
      const current = lastBlock(stack);
      if (!current) {
        problems.push(makeDiagnostic(line, `${keyword} without matching ${expectedOpening}.`, vscode.DiagnosticSeverity.Error));
        continue;
      }

      if (current.keyword !== expectedOpening) {
        problems.push(makeDiagnostic(
          line,
          `${keyword} closes ${expectedOpening}, but the current open block is ${current.keyword} from line ${current.lineNumber + 1}.`,
          vscode.DiagnosticSeverity.Error
        ));
        continue;
      }

      stack.pop();
    }
  }

  for (const open of stack) {
    const line = document.lineAt(open.lineNumber);
    problems.push(makeDiagnostic(
      line,
      `${open.keyword} is not closed with ${blockPairs.get(open.keyword)}.`,
      vscode.DiagnosticSeverity.Error
    ));
  }

  diagnostics.set(document.uri, problems);
}

function makeDiagnostic(line, message, severity) {
  const start = line.firstNonWhitespaceCharacterIndex;
  const end = Math.max(start + 1, line.text.length);
  return new vscode.Diagnostic(new vscode.Range(line.lineNumber, start, line.lineNumber, end), message, severity);
}

function lastBlock(stack) {
  return stack.length ? stack[stack.length - 1] : undefined;
}

function closeFoldingRange(stack, ranges, expectedKeyword, endLine) {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].keyword === expectedKeyword) {
      const start = stack[index].line;
      stack.splice(index);
      if (endLine > start) {
        ranges.push(new vscode.FoldingRange(start, endLine));
      }
      return;
    }
  }
}

function firstKeyword(text) {
  const match = text.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match ? match[0].toUpperCase() : "";
}

function stripComment(text) {
  let inSingle = false;
  let inDouble = false;

  if (/^\s*!/.test(text) && !/^\s*!!/.test(text)) {
    return "";
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === "!" && text[index + 1] === "!" && !inSingle && !inDouble) {
      return text.slice(0, index);
    }
  }

  return text;
}

async function showBlockTree() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE) {
    vscode.window.showWarningMessage("Open an IAF file first.");
    return;
  }

  const lines = buildBlockTreeLines(editor.document);
  const treeDocument = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: lines.join("\n")
  });
  await vscode.window.showTextDocument(treeDocument, vscode.ViewColumn.Beside, true);
}

async function addEndComments() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE) {
    vscode.window.showWarningMessage("Open an IAF file first.");
    return;
  }

  const annotated = buildEndCommentText(editor.document);
  const document = await vscode.workspace.openTextDocument({
    language: LANGUAGE,
    content: annotated
  });
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside, true);
}

async function exportHtml() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE) {
    vscode.window.showWarningMessage("Open an IAF file first.");
    return;
  }

  if (editor.document.isUntitled) {
    vscode.window.showWarningMessage("Save the IAF file before exporting HTML.");
    return;
  }

  const document = editor.document;
  const parsedTree = buildBlockTree(document);
  const html = buildHtmlExport(document, parsedTree.roots);
  const parsedPath = path.parse(document.fileName);
  const htmlPath = path.join(parsedPath.dir, `${parsedPath.name}.blocks.html`);

  await fs.promises.writeFile(htmlPath, html, "utf8");
  const open = "Open HTML";
  const result = await vscode.window.showInformationMessage(`IAF HTML exported: ${htmlPath}`, open);
  if (result === open) {
    await vscode.env.openExternal(vscode.Uri.file(htmlPath));
  }
}

function buildEndCommentText(document) {
  const lines = [];
  const stack = [];

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const original = document.lineAt(lineNumber).text;
    const code = stripComment(original).trim();
    const keyword = firstKeyword(code);

    if (blockPairs.has(keyword)) {
      stack.push({ keyword, text: compactLine(code), lineNumber });
      lines.push(original);
      continue;
    }

    if (closingToOpening.has(keyword)) {
      const expected = closingToOpening.get(keyword);
      const current = stack.length ? stack[stack.length - 1] : undefined;

      if (current && current.keyword === expected) {
        stack.pop();
        lines.push(withEndComment(original, current));
        continue;
      }
    }

    lines.push(original);
  }

  return lines.join(document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
}

function withEndComment(line, opening) {
  if (hasInlineDoubleBangComment(line)) {
    return line;
  }

  const suffix = `  !! ${opening.text}`;
  return `${line.replace(/\s+$/, "")}${suffix}`;
}

function hasInlineDoubleBangComment(text) {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === "!" && text[index + 1] === "!" && !inSingle && !inDouble) {
      return true;
    }
  }

  return false;
}

function buildBlockTreeLines(document) {
  const output = [`IAF Block Tree: ${path.basename(document.fileName)}`, ""];
  const stack = [];

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const raw = document.lineAt(lineNumber).text;
    const code = stripComment(raw).trim();
    const keyword = firstKeyword(code);

    if (!keyword) {
      continue;
    }

    if (blockPairs.has(keyword)) {
      output.push(`${"  ".repeat(stack.length)}L${String(lineNumber + 1).padStart(4, " ")}  ${compactLine(code)}`);
      stack.push({ keyword, lineNumber });
      continue;
    }

    if (middleKeywords.has(keyword)) {
      output.push(`${"  ".repeat(Math.max(stack.length - 1, 0))}L${String(lineNumber + 1).padStart(4, " ")}  ${compactLine(code)}`);
      continue;
    }

    if (closingToOpening.has(keyword)) {
      if (stack.length > 0) {
        stack.pop();
      }
      output.push(`${"  ".repeat(stack.length)}L${String(lineNumber + 1).padStart(4, " ")}  ${keyword}`);
    }
  }

  return output;
}

function buildBlockTree(document) {
  const roots = [];
  const stack = [];

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const raw = document.lineAt(lineNumber).text;
    const code = stripComment(raw).trim();
    const keyword = firstKeyword(code);

    if (!keyword) {
      continue;
    }

    if (blockPairs.has(keyword)) {
      const node = makeBlockNode(document, lineNumber, keyword, code);
      addBlockNode(roots, stack, node);
      stack.push(node);
      continue;
    }

    if (middleKeywords.has(keyword)) {
      const node = makeBlockNode(document, lineNumber, keyword, code);
      if (stack.length && stack[stack.length - 1].keyword === "IF") {
        stack[stack.length - 1].children.push(node);
      } else {
        addBlockNode(roots, stack, node);
      }
      continue;
    }

    if (closingToOpening.has(keyword)) {
      const expected = closingToOpening.get(keyword);
      if (stack.length && stack[stack.length - 1].keyword === expected) {
        stack.pop();
      }
    }
  }

  return { roots };
}

function buildHtmlExport(document, roots) {
  const title = path.basename(document.fileName);
  const lineCount = document.lineCount;
  const generatedAt = new Date().toLocaleString();
  const treeHtml = roots.length ? buildHtmlTree(roots) : "<p>No IAF blocks found.</p>";
  const codeHtml = buildHtmlCode(document);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - IAF Blocks</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f7f7f8;
  --panel: #ffffff;
  --text: #1f2328;
  --muted: #6e7781;
  --border: #d0d7de;
  --line: #8c959f;
  --keyword: #0969da;
  --control: #8250df;
  --comment: #57606a;
  --string: #0a7f42;
  --variable: #953800;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --text: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
    --line: #6e7681;
    --keyword: #79c0ff;
    --control: #d2a8ff;
    --comment: #8b949e;
    --string: #7ee787;
    --variable: #ffa657;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
header {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
h1 { margin: 0; font-size: 18px; font-weight: 650; }
.meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
.layout {
  display: grid;
  grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
  min-height: calc(100vh - 63px);
}
nav {
  position: sticky;
  top: 63px;
  max-height: calc(100vh - 63px);
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 12px;
}
main { overflow: auto; }
ul { list-style: none; margin: 0; padding-left: 15px; }
nav > ul { padding-left: 0; }
li { margin: 3px 0; }
a { color: var(--text); text-decoration: none; }
a:hover { color: var(--keyword); text-decoration: underline; }
.line-ref { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
pre {
  margin: 0;
  padding: 16px 0;
  font: 13px/1.45 Consolas, "Cascadia Mono", "Courier New", monospace;
  tab-size: 4;
}
.code-line {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  min-height: 19px;
}
.code-line:target { background: color-mix(in srgb, var(--keyword) 18%, transparent); }
.ln {
  padding-right: 14px;
  color: var(--line);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border);
}
.src {
  padding-left: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.kw { color: var(--keyword); font-weight: 650; }
.ctrl { color: var(--control); font-weight: 650; }
.comment { color: var(--comment); font-style: italic; }
.str { color: var(--string); }
.var { color: var(--variable); }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  nav { position: static; max-height: none; border-right: 0; border-bottom: 1px solid var(--border); }
}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${lineCount} lines, exported ${escapeHtml(generatedAt)}</div>
</header>
<div class="layout">
  <nav aria-label="IAF block tree">
    ${treeHtml}
  </nav>
  <main>
    <pre>${codeHtml}</pre>
  </main>
</div>
</body>
</html>
`;
}

function buildHtmlTree(nodes) {
  return `<ul>${nodes.map((node) => {
    const children = node.children.length ? buildHtmlTree(node.children) : "";
    return `<li><a href="#L${node.lineNumber + 1}"><span class="line-ref">L${node.lineNumber + 1}</span>${escapeHtml(node.label)}</a>${children}</li>`;
  }).join("")}</ul>`;
}

function buildHtmlCode(document) {
  const lines = [];
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const raw = document.lineAt(lineNumber).text;
    lines.push(`<span class="code-line" id="L${lineNumber + 1}"><span class="ln">${lineNumber + 1}</span><span class="src">${highlightHtmlLine(raw)}</span></span>`);
  }
  return lines.join("\n");
}

function highlightHtmlLine(raw) {
  const commentStart = findDoubleBangComment(raw);
  const code = commentStart >= 0 ? raw.slice(0, commentStart) : raw;
  const comment = commentStart >= 0 ? raw.slice(commentStart) : "";
  const lineComment = /^\s*!/.test(raw) && !/^\s*!!/.test(raw);

  if (lineComment) {
    return `<span class="comment">${escapeHtml(raw)}</span>`;
  }

  return highlightHtmlCodePart(code) + (comment ? `<span class="comment">${escapeHtml(comment)}</span>` : "");
}

function highlightHtmlCodePart(code) {
  const escaped = escapeHtml(code);
  return escaped.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|\$[A-Za-z_][A-Za-z0-9_]*|\b(?:PROCEDURE|END_PROCEDURE|IF|ELSE_IF|ELSE|END_IF|DO_WHILE|END_DO|SELECT_ALL|END_SELECT|READ_ALL|END_READ)\b|\b(?:EXECSQL|SELECT|UPDATE|DELETE|INSERT|READ|WRITE|COMMIT|ROLLBACK|PERFORM|DEFINE_LOCAL|INIT|INIT_RECORD|PAUSE|ERRMSG|CHECK|ADD|BREAK)\b)/gi, (match) => {
    if (match.startsWith("&quot;") || match.startsWith("&#39;")) {
      return `<span class="str">${match}</span>`;
    }
    if (match.startsWith("$")) {
      return `<span class="var">${match}</span>`;
    }
    if (/^(PROCEDURE|END_PROCEDURE|IF|ELSE_IF|ELSE|END_IF|DO_WHILE|END_DO|SELECT_ALL|END_SELECT|READ_ALL|END_READ)$/i.test(match)) {
      return `<span class="ctrl">${match}</span>`;
    }
    return `<span class="kw">${match}</span>`;
  });
}

function findDoubleBangComment(text) {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === "!" && text[index + 1] === "!" && !inSingle && !inDouble) {
      return index;
    }
  }

  return -1;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeBlockNode(document, lineNumber, keyword, text) {
  return {
    uri: document.uri,
    keyword,
    lineNumber,
    text,
    label: compactLine(text),
    children: []
  };
}

function addBlockNode(roots, stack, node) {
  if (stack.length) {
    stack[stack.length - 1].children.push(node);
  } else {
    roots.push(node);
  }
}

async function goToBlock(item) {
  if (!item || !item.uri) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(item.uri);
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(item.lineNumber, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

function iconForKeyword(keyword) {
  if (keyword === "IF" || keyword === "ELSE" || keyword === "ELSE_IF") {
    return "symbol-boolean";
  }
  if (keyword === "DO_WHILE") {
    return "sync";
  }
  if (keyword === "SELECT_ALL") {
    return "database";
  }
  if (keyword === "READ_ALL") {
    return "book";
  }
  if (keyword === "PROCEDURE") {
    return "symbol-method";
  }
  return "symbol-keyword";
}

function compactLine(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function loadHelpIndex(extensionPath) {
  const file = path.join(extensionPath, "data", "help-index.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallbackKeywords.map((name) => ({ name }));
  }
}

function buildHelpMarkdown(entry, includeExamples) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${entry.name}**`);
  if (entry.description) {
    markdown.appendMarkdown(`\n\n${entry.description}`);
  }

  const syntax = firstSyntax(entry);
  if (syntax) {
    markdown.appendMarkdown(`\n\n\`\`\`iaf\n${syntax}\n\`\`\``);
  }

  if (includeExamples && entry.examples && entry.examples.length) {
    markdown.appendMarkdown("\n\nExamples:");
    for (const example of entry.examples.slice(0, 3)) {
      markdown.appendMarkdown(`\n\n\`\`\`iaf\n${example}\n\`\`\``);
    }
  }

  return markdown;
}

function firstSyntax(entry) {
  return entry.syntax && entry.syntax.length ? entry.syntax[0] : "";
}

function syntaxToSnippet(syntax) {
  let placeholder = 1;
  const withParameters = syntax.replace(/\(([^)]*)\)/, (match, parameters) => {
    const parts = parameters.split(",").map((parameter) => parameter.trim()).filter(Boolean);
    if (!parts.length) {
      return match;
    }

    return `(${parts.map((parameter) => `\${${placeholder++}:${parameter}}`).join(", ")})`;
  });

  return withParameters.replace(/\b([a-z][A-Za-z0-9_$]*)\b/g, (match) => {
    if (/^(date|time|datetime|numeric|alpha|expression|value|field|record)$/i.test(match)) {
      return `\${${placeholder++}:${match}}`;
    }
    return match;
  });
}

function shouldWarnUnknownKeyword(code, keyword) {
  if (isKnownHelpKeyword(keyword)) {
    return false;
  }

  if (!/^[A-Z_][A-Z0-9_]*$/.test(keyword)) {
    return false;
  }

  if (/^\$/.test(code) || /^[A-Za-z_][A-Za-z0-9_]*\./.test(code)) {
    return false;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(code)) {
    return false;
  }

  return true;
}

function isKnownHelpKeyword(keyword) {
  return helpByName.has(keyword)
    || fallbackKeywords.includes(keyword)
    || contextualKeywords.has(keyword)
    || blockPairs.has(keyword)
    || closingToOpening.has(keyword)
    || middleKeywords.has(keyword);
}

function closestHelpNames(keyword, count) {
  const candidates = helpIndex
    .map((entry) => entry.name)
    .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name));

  return candidates
    .map((name) => ({ name, score: levenshtein(keyword, name) }))
    .filter((item) => item.score <= Math.max(2, Math.floor(keyword.length / 3)))
    .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
    .slice(0, count)
    .map((item) => item.name);
}

function levenshtein(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let index = 1; index <= right.length; index++) {
    rows[0][index] = index;
  }

  for (let row = 1; row <= left.length; row++) {
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost
      );
    }
  }

  return rows[left.length][right.length];
}

async function openHelpForWord() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE) {
    await searchHelp();
    return;
  }

  const range = editor.document.getWordRangeAtPosition(editor.selection.active, /(?:\$?[A-Za-z_][A-Za-z0-9_]*)/);
  const rawWord = range ? editor.document.getText(range) : "";
  const word = rawWord.replace(/^\$/, "").toUpperCase();
  const entry = helpByName.get(word);
  if (!entry) {
    await searchHelp(rawWord);
    return;
  }

  await openHelpEntry(entry);
}

async function searchHelp(initialQuery = "") {
  const source = helpIndex.length ? helpIndex : fallbackKeywords.map((name) => ({ name }));
  const items = source
    .map((entry) => ({
      label: entry.name,
      description: entry.file || "",
      detail: entry.description || "",
      entry
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const selected = await showHelpQuickPick(items, initialQuery);
  if (!selected) {
    return;
  }

  await openHelpEntry(selected.entry);
}

function showHelpQuickPick(items, initialQuery) {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = "IAF Help";
    quickPick.placeholder = "Search IAF statements, functions and topics";
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.ignoreFocusOut = true;
    quickPick.items = items;
    quickPick.value = initialQuery.replace(/^\$/, "");

    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0];
      quickPick.hide();
      resolve(selected);
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(undefined);
    });
    quickPick.show();
  });
}

async function openHelpEntry(entry) {
  const helpFolder = await resolveHelpFolder();
  if (!helpFolder) {
    vscode.window.showWarningMessage("Set iaf.helpPath or open a workspace containing the IAFHelp folder.");
    return;
  }

  const helpFile = path.join(helpFolder, entry.file);
  if (!fs.existsSync(helpFile)) {
    vscode.window.showWarningMessage(`Help file not found: ${helpFile}`);
    return;
  }

  openHelpWebview(helpFolder, entry);
}

async function openHelpContents() {
  const helpFolder = await resolveHelpFolder();
  if (!helpFolder) {
    vscode.window.showWarningMessage("Set iaf.helpPath or open a workspace containing the IAFHelp folder.");
    return;
  }

  const entry = helpByName.get("INTRODUCTION TO IAF")
    || helpByName.get("INTRODUCTION")
    || helpIndex.find((item) => item.file === "introduction.htm")
    || helpIndex[0];

  if (entry) {
    openHelpWebview(helpFolder, entry);
  }
}

function openHelpWebview(helpFolder, selectedEntry) {
  if (!extensionContext) {
    return;
  }

  if (!helpPanel) {
    helpPanel = vscode.window.createWebviewPanel(
      "iafHelp",
      "IAF Help",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(helpFolder)]
      }
    );
    helpPanel.onDidDispose(() => {
      helpPanel = undefined;
    }, null, extensionContext.subscriptions);
  }

  helpPanel.title = `IAF Help: ${selectedEntry.name}`;
  helpPanel.webview.html = buildHelpWebviewHtml(helpPanel.webview, helpFolder, selectedEntry);
  helpPanel.reveal(vscode.ViewColumn.Beside);
}

function buildHelpWebviewHtml(webview, helpFolder, selectedEntry) {
  const entries = helpIndex
    .filter((entry) => entry.file)
    .map((entry) => ({
      name: entry.name,
      file: entry.file,
      description: entry.description || "",
      text: entry.text || "",
      html: prepareHelpTopicHtml(webview, helpFolder, entry.file)
    }));
  const selected = entries.find((entry) => entry.file === selectedEntry.file) || entries[0];
  const nonce = String(Date.now());

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IAF Help</title>
<style>
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border);
  --input: var(--vscode-input-background);
  --active: var(--vscode-list-activeSelectionBackground);
  --active-fg: var(--vscode-list-activeSelectionForeground);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--fg);
  background: var(--bg);
  font: 13px/1.4 var(--vscode-font-family);
}
.layout {
  display: grid;
  grid-template-columns: minmax(230px, 320px) minmax(0, 1fr);
  height: 100vh;
}
aside {
  border-right: 1px solid var(--border);
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.search {
  padding: 10px;
  border-bottom: 1px solid var(--border);
}
input {
  width: 100%;
  color: var(--fg);
  background: var(--input);
  border: 1px solid var(--border);
  padding: 6px 8px;
  outline: none;
}
.topics {
  overflow: auto;
  padding: 6px;
}
button {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--fg);
  text-align: left;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}
button:hover { background: var(--vscode-list-hoverBackground); }
button.active {
  background: var(--active);
  color: var(--active-fg);
}
.title {
  display: block;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.desc {
  display: block;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bar {
  min-height: 40px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.content {
  min-height: 0;
  overflow: auto;
  background: #ffffff;
  color: #111111;
  padding: 14px 18px;
}
.content :is(body, table, div, p, span, font, td) {
  color: inherit;
}
.content a {
  color: #0645ad;
}
.content table {
  max-width: 100%;
}
.content img {
  max-width: 100%;
}
@media (max-width: 760px) {
  .layout { grid-template-columns: 1fr; }
  aside { max-height: 42vh; border-right: 0; border-bottom: 1px solid var(--border); }
}
</style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="search">
      <input id="search" type="search" placeholder="Search help" autofocus>
    </div>
    <div id="topics" class="topics"></div>
  </aside>
  <main>
    <div id="bar" class="bar"></div>
    <div id="content" class="content"></div>
  </main>
</div>
<script nonce="${nonce}">
const entries = ${safeScriptJson(entries)};
let selectedFile = ${JSON.stringify(selected.file)};
const search = document.getElementById("search");
const topics = document.getElementById("topics");
const content = document.getElementById("content");
const bar = document.getElementById("bar");

function render() {
  const query = search.value.trim().toLowerCase();
  const visible = entries.filter((entry) => {
    const haystack = (entry.name + " " + entry.description + " " + entry.text).toLowerCase();
    return !query || haystack.includes(query);
  }).slice(0, 250);

  topics.textContent = "";
  for (const entry of visible) {
    const button = document.createElement("button");
    button.className = entry.file === selectedFile ? "active" : "";
    button.type = "button";
    button.dataset.file = entry.file;
    button.innerHTML = "<span class=\\"title\\"></span><span class=\\"desc\\"></span>";
    button.querySelector(".title").textContent = entry.name;
    button.querySelector(".desc").textContent = entry.description;
    button.addEventListener("click", () => select(entry));
    topics.appendChild(button);
  }
}

function select(entry) {
  selectedFile = entry.file;
  content.innerHTML = entry.html;
  bar.textContent = entry.name;
  render();
}

search.addEventListener("input", render);
content.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-help-file]");
  if (!link) {
    return;
  }

  event.preventDefault();
  const entry = entries.find((item) => item.file.toLowerCase() === link.dataset.helpFile.toLowerCase());
  if (entry) {
    select(entry);
  }
});
select(entries.find((entry) => entry.file === selectedFile) || entries[0]);
</script>
</body>
</html>`;
}

function prepareHelpTopicHtml(webview, helpFolder, file) {
  const fullPath = path.join(helpFolder, file);
  let html = "";
  try {
    html = fs.readFileSync(fullPath, "utf8");
  } catch {
    return `<p>Help file not found: ${escapeHtml(file)}</p>`;
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : html;
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\s(?:background|bgcolor)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  body = body.replace(/\s(src)=("([^"]+)"|'([^']+)'|([^\s>]+))/gi, (match, attr, _all, doubleValue, singleValue, bareValue) => {
    const value = doubleValue || singleValue || bareValue || "";
    const rewritten = rewriteHelpResource(webview, helpFolder, file, value);
    return ` ${attr}="${escapeHtml(rewritten)}"`;
  });

  body = body.replace(/\s(href)=("([^"]+)"|'([^']+)'|([^\s>]+))/gi, (match, attr, _all, doubleValue, singleValue, bareValue) => {
    const value = doubleValue || singleValue || bareValue || "";
    if (/\.html?(?:#.*)?$/i.test(value) && !/^[a-z]+:/i.test(value)) {
      const localFile = path.basename(value.split("#")[0]);
      return ` href="#" data-help-file="${escapeHtml(localFile)}"`;
    }
    return ` ${attr}="${escapeHtml(value)}"`;
  });

  return body;
}

function rewriteHelpResource(webview, helpFolder, currentFile, value) {
  if (/^(?:[a-z]+:|#|data:)/i.test(value)) {
    return value;
  }

  const currentFolder = path.dirname(path.join(helpFolder, currentFile));
  return webview.asWebviewUri(vscode.Uri.file(path.resolve(currentFolder, value))).toString();
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

async function resolveHelpFolder() {
  const configured = vscode.workspace.getConfiguration("iaf").get("helpPath");
  if (configured && fs.existsSync(configured)) {
    return configured;
  }

  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, "IAFHelp");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parentCandidate = path.join(folder.uri.fsPath, "..", "IAFHelp");
    if (fs.existsSync(parentCandidate)) {
      return parentCandidate;
    }
  }

  return undefined;
}

module.exports = {
  activate,
  deactivate
};
