# IAF Language Support

Local Visual Studio Code support for IAF code.

## Features

- Syntax highlighting for IAF keywords, SQL fragments, comments, strings, fields, and `$local` variables.
- Snippets for common IAF blocks.
- Folding for `IF/END_IF`, `DO_WHILE/END_DO`, `SELECT_ALL/END_SELECT`, and `!#region`.
- Diagnostics for mismatched block endings.
- Hover and completion help generated from the local `IAFHelp` HTML files.
- Command `IAF: Add END Comments` opens an annotated copy with comments on matching `END_*` lines.
- Command `IAF: Export HTML` writes a standalone `.blocks.html` file with a block tree and highlighted source.

## Local usage

Open this folder in VS Code and press `F5` to start an Extension Development Host.

To install locally as a VSIX:

```powershell
npm install -g @vscode/vsce
cd iaf-vscode-extension
vsce package
code --install-extension .\iaf-language-support-0.0.1.vsix
```
