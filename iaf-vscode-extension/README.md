# IAF Editor Toolkit

Visual Studio Code language support for IAF code.

## Features

- Syntax highlighting for IAF keywords, SQL fragments, comments, strings, fields, and `$local` variables.
- Snippets for common IAF blocks.
- Folding for `IF/END_IF`, `DO_WHILE/END_DO`, `SELECT_ALL/END_SELECT`, and `!#region`.
- Diagnostics for mismatched block endings and likely unknown IAF commands.
- Hover and completion help generated from the local `IAFHelp` HTML files, including syntax and examples when available.
- `Ctrl+K` then `H`, or command `IAF: Open Help For Word`, opens the matching help topic inside a VS Code webview.
- Command `IAF: Search Help` searches all indexed IAF help topics and opens the selected topic in the webview.
- Command `IAF: Open Help Contents` opens the searchable help webview.
- Command `IAF: Select Help Folder` connects the extension to the `IAFHelp` folder from a local IAF installation.
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

To regenerate help metadata after changing files in `IAFHelp`:

```powershell
npm run generate-help-index
```

## IAF Help

The original IAF HTML documentation is not distributed with this extension. To enable full help pages, run `IAF: Select Help Folder` from the Command Palette and select the `IAFHelp` directory from your local IAF installation. The selected path is saved in your global VS Code settings.

The extension can also find an `IAFHelp` directory in the current workspace or its parent directory.

## Privacy

The extension works locally. It does not upload source code or IAF Help content.

## License

The extension source code is available under the MIT License. IAF and its documentation remain the property of their respective owners.
