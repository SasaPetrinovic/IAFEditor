const fs = require("fs");
const path = require("path");

const extensionRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extensionRoot, "..");
const helpRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "IAFHelp");
const outputFile = path.join(extensionRoot, "data", "help-index.json");

if (!fs.existsSync(helpRoot)) {
  console.error(`IAFHelp folder not found: ${helpRoot}`);
  process.exit(1);
}

const files = fs.readdirSync(helpRoot)
  .filter((file) => /\.html?$/i.test(file))
  .sort((left, right) => left.localeCompare(right));

const entries = files
  .map((file) => buildEntry(file, fs.readFileSync(path.join(helpRoot, file), "utf8")))
  .filter((entry) => entry.name);

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
console.log(`Generated ${entries.length} help entries: ${outputFile}`);

function buildEntry(file, html) {
  const title = extractTitle(html) || titleFromFile(file);
  const lines = htmlToLines(html);
  const text = lines.join(" ");
  const description = firstMeaningfulDescription(lines, title);
  const syntax = extractSyntax(lines, title);
  const examples = extractExamples(lines, title);

  return {
    name: title,
    file,
    description,
    syntax,
    examples,
    text: compact(text, 1200)
  };
}

function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return cleanText(titleMatch[1]);
  }

  const headingMatch = html.match(/font-size:\s*14pt[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
  return headingMatch ? cleanText(headingMatch[1]) : "";
}

function titleFromFile(file) {
  return path.basename(file, path.extname(file))
    .replace(/_/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function htmlToLines(html) {
  const normalized = html
    .replace(/\r?\n/g, " ")
    .replace(/<\/(?:div|p|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split(/\n+/)
    .map(cleanText)
    .filter(Boolean);

  return normalized.filter((line, index) => index === 0 || line !== normalized[index - 1]);
}

function firstMeaningfulDescription(lines, title) {
  const skipped = new Set([
    title.toUpperCase(),
    "FORMAT",
    "FORMAT 1",
    "FORMAT 2",
    "WHERE",
    "PARAMETERS",
    "RETURN VALUE TYPE",
    "EXAMPLES",
    "SEE ALSO",
    "NOTES"
  ]);

  const line = lines.find((value) => {
    const upper = value.toUpperCase();
    return value.length > 12 && !skipped.has(upper) && !looksLikeSyntax(value);
  });

  return compact(line || title, 260);
}

function extractSyntax(lines, title) {
  const syntaxes = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/^Format(?:\s+\d+)?(?:\b.*)?$/i.test(lines[index])) {
      continue;
    }

    for (let offset = index + 1; offset < Math.min(index + 6, lines.length); offset++) {
      const candidate = lines[offset];
      if (looksLikeSection(candidate)) {
        break;
      }
      if (looksLikeSyntax(candidate) || candidate.toUpperCase().includes(title.toUpperCase())) {
        syntaxes.push(candidate);
        break;
      }
    }
  }

  return unique(syntaxes).slice(0, 4);
}

function extractExamples(lines, title) {
  const examples = [];
  const titleUpper = title.toUpperCase();
  const start = lines.findIndex((line) => /^Examples?$/i.test(line));
  if (start < 0) {
    return examples;
  }

  for (let index = start + 1; index < lines.length && examples.length < 6; index++) {
    const line = lines[index];
    if (/^(See Also|Notes?|Parameters|Where)\b/i.test(line)) {
      break;
    }
    if (line.length > 4 && (line.toUpperCase().includes(titleUpper) || looksLikeCode(line))) {
      examples.push(line);
    }
  }

  return unique(examples).slice(0, 5);
}

function looksLikeSection(value) {
  return /^(Format(?:\s+\d+)?(?:\b.*)?|Where|Parameters|Return Value Type|Examples?|See Also|Notes?)$/i.test(value);
}

function looksLikeSyntax(value) {
  return /^[A-Z_][A-Z0-9_]*(?:\s|\(|$)/.test(value) && value.length <= 140;
}

function looksLikeCode(value) {
  return /^(\$?[A-Za-z_][A-Za-z0-9_]*\s*=|[A-Z_][A-Z0-9_]*\s|\s*EXECSQL\b)/.test(value);
}

function unique(values) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function compact(value, maxLength) {
  const normalized = cleanText(value).replace(/\s+/g, " ");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function cleanText(value) {
  return decodeEntities(String(value))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
    rsquo: "'",
    lsquo: "'",
    rdquo: "\"",
    ldquo: "\"",
    hellip: "...",
    middot: "-"
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}
