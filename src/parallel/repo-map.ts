import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { RepoMap, RepoMapEntry, RepoDeclaration } from './types.js';
import type { LanguageInfo } from './language-detect.js';

// ---------------------------------------------------------------------------
// Repo map — regex-based signature extraction
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'target', 'build', 'dist',
  '.lockstep', '.next', '.nuxt', 'vendor', 'venv', '.venv', 'env',
  'coverage', '.cache', '.turbo',
]);

const MAX_FILE_SIZE = 100_000; // 100KB — skip huge generated files
const MAX_FILES = 200;         // cap to avoid token explosion
const MAX_DEPTH = 4;

/**
 * Generates an AST-like repo map by scanning the project directory
 * and extracting function/class/interface/type signatures using regex.
 *
 * Returns a compact map that gives the coordinator structural awareness
 * without sending full file contents (50-100x token compression).
 */
export async function generateRepoMap(
  workingDirectory: string,
  language: LanguageInfo,
): Promise<RepoMap> {
  const files: string[] = [];
  await collectFiles(workingDirectory, workingDirectory, language.extensions, files, 0);

  // Cap file count
  const filesToProcess = files.slice(0, MAX_FILES);

  const entries: RepoMapEntry[] = [];
  let totalDeclarations = 0;

  for (const file of filesToProcess) {
    try {
      const fileStat = await stat(file);
      if (fileStat.size > MAX_FILE_SIZE) continue;

      const content = await readFile(file, 'utf-8');
      const relativePath = path.relative(workingDirectory, file);
      const entry = parseFileDeclarations(relativePath, content, language.id);

      if (entry.declarations.length > 0 || entry.exports.length > 0) {
        entries.push(entry);
        totalDeclarations += entry.declarations.length;
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Estimate tokens (~4 chars per token for code)
  const mapText = formatRepoMap(entries);
  const tokenEstimate = Math.ceil(mapText.length / 4);

  return {
    entries,
    total_files: entries.length,
    total_declarations: totalDeclarations,
    token_estimate: tokenEstimate,
  };
}

/**
 * Formats the repo map as a compact text representation
 * suitable for injection into an LLM prompt.
 */
export function formatRepoMap(entries: RepoMapEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    lines.push(`${entry.file}:`);

    for (const decl of entry.declarations) {
      lines.push(`  ${decl.kind} ${decl.signature}`);
    }

    if (entry.exports.length > 0) {
      lines.push(`  exports: ${entry.exports.join(', ')}`);
    }

    if (entry.imports.length > 0) {
      lines.push(`  imports: ${entry.imports.join(', ')}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

async function collectFiles(
  rootDir: string,
  dir: string,
  extensions: string[],
  files: string[],
  depth: number,
): Promise<void> {
  if (depth >= MAX_DEPTH || files.length >= MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await collectFiles(rootDir, path.join(dir, entry.name), extensions, files, depth + 1);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (extensions.includes(ext)) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Language-specific parsers
// ---------------------------------------------------------------------------

function parseFileDeclarations(
  filePath: string,
  content: string,
  languageId: string,
): RepoMapEntry {
  switch (languageId) {
    case 'typescript':
    case 'javascript':
      return parseTypeScript(filePath, content);
    case 'python':
      return parsePython(filePath, content);
    case 'go':
      return parseGo(filePath, content);
    case 'rust':
      return parseRust(filePath, content);
    case 'java':
      return parseJava(filePath, content);
    case 'c':
    case 'cpp':
      return parseCpp(filePath, content);
    case 'ruby':
      return parseRuby(filePath, content);
    default:
      return { file: filePath, declarations: [], exports: [], imports: [] };
  }
}

// --- TypeScript / JavaScript ---

function parseTypeScript(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Exports: export function/class/interface/type/const/enum
    let m = line.match(/^export\s+(?:default\s+)?(?:abstract\s+)?(function|class|interface|type|const|enum|let|var)\s+(\w+)/);
    if (m) {
      const kind = m[1];
      const name = m[2];
      const sig = extractTSSignature(line, lines, i);
      declarations.push({ name, kind, signature: sig, line: lineNum });
      exports.push(name);
      continue;
    }

    // export async function
    m = line.match(/^export\s+async\s+function\s+(\w+)/);
    if (m) {
      const sig = extractTSSignature(line, lines, i);
      declarations.push({ name: m[1], kind: 'function', signature: sig, line: lineNum });
      exports.push(m[1]);
      continue;
    }

    // Non-exported declarations
    m = line.match(/^(?:abstract\s+)?(function|class|interface|type|const|enum)\s+(\w+)/);
    if (m) {
      const sig = extractTSSignature(line, lines, i);
      declarations.push({ name: m[2], kind: m[1], signature: sig, line: lineNum });
      continue;
    }

    // async function (non-exported)
    m = line.match(/^async\s+function\s+(\w+)/);
    if (m) {
      const sig = extractTSSignature(line, lines, i);
      declarations.push({ name: m[1], kind: 'function', signature: sig, line: lineNum });
      continue;
    }

    // Re-exports: export { ... } from '...'
    m = line.match(/^export\s*\{([^}]+)\}/);
    if (m) {
      const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
      exports.push(...names);
      continue;
    }

    // Imports: import { ... } from '...'
    m = line.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      imports.push(m[2]);
      continue;
    }

    // import X from '...'
    m = line.match(/^import\s+\w+\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      imports.push(m[1]);
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}

function extractTSSignature(line: string, lines: string[], index: number): string {
  // Get the signature part (up to the opening brace or end of line)
  let sig = line.trim();

  // For multi-line signatures (e.g., function with many params), collect until we see {
  if (!sig.includes('{') && !sig.includes(';') && !sig.endsWith(',')) {
    for (let j = index + 1; j < Math.min(index + 5, lines.length); j++) {
      const next = lines[j].trim();
      sig += ' ' + next;
      if (next.includes('{') || next.includes(';')) break;
    }
  }

  // Trim everything after opening brace
  const braceIdx = sig.indexOf('{');
  if (braceIdx > 0) sig = sig.slice(0, braceIdx).trim();

  // Remove export/async/abstract prefixes for cleaner output
  sig = sig.replace(/^export\s+(default\s+)?/, '').replace(/^async\s+/, 'async ').replace(/^abstract\s+/, 'abstract ');

  return sig.slice(0, 200); // Cap length
}

// --- Python ---

function parsePython(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // class Foo(Base):
    let m = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?/);
    if (m) {
      const bases = m[2] ? `(${m[2]})` : '';
      declarations.push({ name: m[1], kind: 'class', signature: `class ${m[1]}${bases}`, line: lineNum });
      continue;
    }

    // def foo(params) -> ReturnType:
    m = line.match(/^(\s*)def\s+(\w+)\(([^)]*)\)(?:\s*->\s*([^:]+))?/);
    if (m) {
      const indent = m[1].length;
      const name = m[2];
      const params = m[3];
      const ret = m[4] ? ` -> ${m[4].trim()}` : '';
      const kind = indent > 0 ? 'method' : 'function';
      declarations.push({ name, kind, signature: `def ${name}(${params})${ret}`, line: lineNum });
      continue;
    }

    // async def foo(params):
    m = line.match(/^(\s*)async\s+def\s+(\w+)\(([^)]*)\)(?:\s*->\s*([^:]+))?/);
    if (m) {
      const indent = m[1].length;
      const name = m[2];
      const params = m[3];
      const ret = m[4] ? ` -> ${m[4].trim()}` : '';
      const kind = indent > 0 ? 'method' : 'function';
      declarations.push({ name, kind, signature: `async def ${name}(${params})${ret}`, line: lineNum });
      continue;
    }

    // from foo import bar, baz
    m = line.match(/^from\s+(\S+)\s+import\s+(.+)/);
    if (m) {
      imports.push(m[1]);
      continue;
    }

    // import foo
    m = line.match(/^import\s+(\S+)/);
    if (m) {
      imports.push(m[1]);
    }
  }

  // Python __all__ as exports
  const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
  if (allMatch) {
    const names = allMatch[1].match(/['"](\w+)['"]/g);
    if (names) {
      exports.push(...names.map((n) => n.replace(/['"]/g, '')));
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}

// --- Go ---

function parseGo(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // func (r *Receiver) Name(params) ReturnType {
    let m = line.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\(([^)]*)\)\s*(.*?)\s*\{?$/);
    if (m) {
      const receiver = m[2] ? `(${m[1]} *${m[2]}) ` : '';
      const name = m[3];
      const params = m[4];
      const ret = m[5] ? ` ${m[5].replace('{', '').trim()}` : '';
      const kind = m[2] ? 'method' : 'function';
      declarations.push({ name, kind, signature: `func ${receiver}${name}(${params})${ret}`, line: lineNum });
      if (name[0] === name[0].toUpperCase()) exports.push(name);
      continue;
    }

    // type Name struct/interface {
    m = line.match(/^type\s+(\w+)\s+(struct|interface)\s*\{?/);
    if (m) {
      declarations.push({ name: m[1], kind: m[2], signature: `type ${m[1]} ${m[2]}`, line: lineNum });
      if (m[1][0] === m[1][0].toUpperCase()) exports.push(m[1]);
      continue;
    }

    // type Name = ...
    m = line.match(/^type\s+(\w+)\s+(.+)/);
    if (m && !m[2].startsWith('struct') && !m[2].startsWith('interface')) {
      declarations.push({ name: m[1], kind: 'type', signature: `type ${m[1]} ${m[2].slice(0, 50)}`, line: lineNum });
      if (m[1][0] === m[1][0].toUpperCase()) exports.push(m[1]);
      continue;
    }

    // import "..."
    m = line.match(/^\s*"([^"]+)"/);
    if (m && content.slice(0, lines.slice(0, i).join('\n').length).includes('import')) {
      imports.push(m[1]);
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}

// --- Rust ---

function parseRust(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // pub fn name(params) -> ReturnType {
    let m = line.match(/^(pub\s+)?(?:async\s+)?fn\s+(\w+)(?:<[^>]*>)?\(([^)]*)\)(?:\s*->\s*(\S+))?\s*\{?/);
    if (m) {
      const vis = m[1] ? 'pub ' : '';
      const name = m[2];
      const params = m[3].slice(0, 80);
      const ret = m[4] ? ` -> ${m[4]}` : '';
      declarations.push({ name, kind: 'function', signature: `${vis}fn ${name}(${params})${ret}`, line: lineNum });
      if (m[1]) exports.push(name);
      continue;
    }

    // pub struct Name
    m = line.match(/^(pub\s+)?struct\s+(\w+)/);
    if (m) {
      declarations.push({ name: m[2], kind: 'struct', signature: `${m[1] || ''}struct ${m[2]}`, line: lineNum });
      if (m[1]) exports.push(m[2]);
      continue;
    }

    // pub trait Name
    m = line.match(/^(pub\s+)?trait\s+(\w+)/);
    if (m) {
      declarations.push({ name: m[2], kind: 'trait', signature: `${m[1] || ''}trait ${m[2]}`, line: lineNum });
      if (m[1]) exports.push(m[2]);
      continue;
    }

    // pub enum Name
    m = line.match(/^(pub\s+)?enum\s+(\w+)/);
    if (m) {
      declarations.push({ name: m[2], kind: 'enum', signature: `${m[1] || ''}enum ${m[2]}`, line: lineNum });
      if (m[1]) exports.push(m[2]);
      continue;
    }

    // impl Trait for Type
    m = line.match(/^impl(?:<[^>]*>)?\s+(\w+)(?:\s+for\s+(\w+))?/);
    if (m) {
      const sig = m[2] ? `impl ${m[1]} for ${m[2]}` : `impl ${m[1]}`;
      declarations.push({ name: m[1], kind: 'method', signature: sig, line: lineNum });
      continue;
    }

    // use crate::foo::bar;
    m = line.match(/^use\s+(\S+);/);
    if (m) {
      imports.push(m[1]);
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}

// --- Java ---

function parseJava(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // public/private class/interface/enum Name
    let m = line.match(/^(public|private|protected)?\s*(?:abstract\s+)?(?:static\s+)?(class|interface|enum|record)\s+(\w+)/);
    if (m) {
      declarations.push({ name: m[3], kind: m[2], signature: line.replace('{', '').trim().slice(0, 150), line: lineNum });
      if (m[1] === 'public') exports.push(m[3]);
      continue;
    }

    // Method declarations
    m = line.match(/^(public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:synchronized\s+)?(?:final\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/);
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'new', 'return'].includes(m[3])) {
      declarations.push({ name: m[3], kind: 'method', signature: line.replace('{', '').trim().slice(0, 150), line: lineNum });
      continue;
    }

    // import statements
    m = line.match(/^import\s+(static\s+)?(\S+);/);
    if (m) {
      imports.push(m[2]);
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}

// --- C/C++ ---

function parseCpp(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // #include
    let m = line.match(/^#include\s+[<"]([^>"]+)[>"]/);
    if (m) {
      imports.push(m[1]);
      continue;
    }

    // class/struct Name
    m = line.match(/^(?:class|struct)\s+(\w+)/);
    if (m) {
      declarations.push({ name: m[1], kind: 'class', signature: line.trim().replace('{', '').trim().slice(0, 150), line: lineNum });
      exports.push(m[1]);
      continue;
    }

    // Function declarations (simplified)
    m = line.match(/^(?:(?:static|inline|virtual|extern|const)\s+)*(\w[\w:*&<> ]*?)\s+(\w+)\s*\([^;]*$/);
    if (m && !['if', 'for', 'while', 'switch', 'return', 'case'].includes(m[2])) {
      declarations.push({ name: m[2], kind: 'function', signature: line.trim().replace('{', '').trim().slice(0, 150), line: lineNum });
      continue;
    }

    // typedef
    m = line.match(/^typedef\s+.+\s+(\w+)\s*;/);
    if (m) {
      declarations.push({ name: m[1], kind: 'type', signature: line.trim().slice(0, 150), line: lineNum });
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}

// --- Ruby ---

function parseRuby(filePath: string, content: string): RepoMapEntry {
  const declarations: RepoDeclaration[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // class Name < Base
    let m = line.match(/^\s*class\s+(\w+)(?:\s*<\s*(\w+))?/);
    if (m) {
      const base = m[2] ? ` < ${m[2]}` : '';
      declarations.push({ name: m[1], kind: 'class', signature: `class ${m[1]}${base}`, line: lineNum });
      exports.push(m[1]);
      continue;
    }

    // module Name
    m = line.match(/^\s*module\s+(\w+)/);
    if (m) {
      declarations.push({ name: m[1], kind: 'interface', signature: `module ${m[1]}`, line: lineNum });
      exports.push(m[1]);
      continue;
    }

    // def method_name(params)
    m = line.match(/^\s*def\s+(self\.)?(\w+[?!=]?)(?:\(([^)]*)\))?/);
    if (m) {
      const prefix = m[1] || '';
      const params = m[3] ? `(${m[3]})` : '';
      declarations.push({ name: m[2], kind: 'method', signature: `def ${prefix}${m[2]}${params}`, line: lineNum });
      continue;
    }

    // require/require_relative
    m = line.match(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/);
    if (m) {
      imports.push(m[1]);
    }
  }

  return { file: filePath, declarations, exports: [...new Set(exports)], imports: [...new Set(imports)] };
}
