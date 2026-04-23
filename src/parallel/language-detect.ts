import { readdir } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Language info interface
// ---------------------------------------------------------------------------

export interface LanguageInfo {
  id: string;
  name: string;
  extensions: string[];
  contracts_extension: string;
  type_system: string;
  contracts_template: string;
}

// ---------------------------------------------------------------------------
// Language definitions
// ---------------------------------------------------------------------------

const LANGUAGES: Record<string, LanguageInfo> = {
  typescript: {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['.ts', '.tsx'],
    contracts_extension: '.ts',
    type_system: 'interfaces and type aliases',
    contracts_template: [
      'export interface UserService {',
      '  getUser(id: string): Promise<User>;',
      '  createUser(data: CreateUserInput): Promise<User>;',
      '}',
      '',
      'export interface User {',
      '  id: string;',
      '  name: string;',
      '}',
    ].join('\n'),
  },
  python: {
    id: 'python',
    name: 'Python',
    extensions: ['.py', '.pyw'],
    contracts_extension: '.py',
    type_system: 'Protocol classes, ABCs, and type hints (from typing import Protocol)',
    contracts_template: [
      'from typing import Protocol',
      '',
      '',
      'class UserService(Protocol):',
      '    def get_user(self, id: str) -> "User": ...',
      '    def create_user(self, data: "CreateUserInput") -> "User": ...',
      '',
      '',
      'class User(Protocol):',
      '    id: str',
      '    name: str',
    ].join('\n'),
  },
  rust: {
    id: 'rust',
    name: 'Rust',
    extensions: ['.rs'],
    contracts_extension: '.rs',
    type_system: 'traits and type aliases',
    contracts_template: [
      'pub trait UserService {',
      '    fn get_user(&self, id: &str) -> User;',
      '    fn create_user(&self, data: CreateUserInput) -> User;',
      '}',
      '',
      'pub struct User {',
      '    pub id: String,',
      '    pub name: String,',
      '}',
    ].join('\n'),
  },
  go: {
    id: 'go',
    name: 'Go',
    extensions: ['.go'],
    contracts_extension: '.go',
    type_system: 'interfaces and type definitions',
    contracts_template: [
      'type UserService interface {',
      '\tGetUser(id string) (*User, error)',
      '\tCreateUser(data CreateUserInput) (*User, error)',
      '}',
      '',
      'type User struct {',
      '\tID   string `json:"id"`',
      '\tName string `json:"name"`',
      '}',
    ].join('\n'),
  },
  java: {
    id: 'java',
    name: 'Java',
    extensions: ['.java'],
    contracts_extension: '.java',
    type_system: 'interfaces and abstract classes',
    contracts_template: [
      'public interface UserService {',
      '    User getUser(String id);',
      '    User createUser(CreateUserInput data);',
      '}',
      '',
      'public record User(String id, String name) {}',
    ].join('\n'),
  },
  javascript: {
    id: 'javascript',
    name: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    contracts_extension: '.js',
    type_system: 'JSDoc @typedef and @interface comments',
    contracts_template: [
      '/**',
      ' * @typedef {Object} User',
      ' * @property {string} id',
      ' * @property {string} name',
      ' */',
      '',
      '/**',
      ' * @interface UserService',
      ' * @method getUser',
      ' * @param {string} id',
      ' * @returns {Promise<User>}',
      ' */',
    ].join('\n'),
  },
  c: {
    id: 'c',
    name: 'C',
    extensions: ['.c', '.h'],
    contracts_extension: '.h',
    type_system: 'header files with struct and function declarations',
    contracts_template: [
      '#ifndef SHARED_CONTRACTS_H',
      '#define SHARED_CONTRACTS_H',
      '',
      'typedef struct {',
      '    char *id;',
      '    char *name;',
      '} User;',
      '',
      'User *get_user(const char *id);',
      'User *create_user(const char *name);',
      '',
      '#endif',
    ].join('\n'),
  },
  cpp: {
    id: 'cpp',
    name: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp'],
    contracts_extension: '.hpp',
    type_system: 'header files with struct and function declarations',
    contracts_template: [
      '#pragma once',
      '#include <string>',
      '',
      'struct User {',
      '    std::string id;',
      '    std::string name;',
      '};',
      '',
      'class UserService {',
      'public:',
      '    virtual ~UserService() = default;',
      '    virtual User getUser(const std::string& id) = 0;',
      '    virtual User createUser(const std::string& name) = 0;',
      '};',
    ].join('\n'),
  },
  ruby: {
    id: 'ruby',
    name: 'Ruby',
    extensions: ['.rb'],
    contracts_extension: '.rb',
    type_system: 'modules and duck typing documentation',
    contracts_template: [
      'module Contracts',
      '  module UserService',
      '    # @param id [String]',
      '    # @return [User]',
      '    def get_user(id) = raise NotImplementedError',
      '',
      '    # @param data [Hash]',
      '    # @return [User]',
      '    def create_user(data) = raise NotImplementedError',
      '  end',
      '',
      '  User = Struct.new(:id, :name, keyword_init: true)',
      'end',
    ].join('\n'),
  },
  scala: {
    id: 'scala',
    name: 'Scala',
    extensions: ['.scala'],
    contracts_extension: '.scala',
    type_system: 'traits and case classes',
    contracts_template: [
      'trait UserService {',
      '  def getUser(id: String): User',
      '  def createUser(data: CreateUserInput): User',
      '}',
      '',
      'case class User(id: String, name: String)',
    ].join('\n'),
  },
  kotlin: {
    id: 'kotlin',
    name: 'Kotlin',
    extensions: ['.kt', '.kts'],
    contracts_extension: '.kt',
    type_system: 'interfaces and data classes',
    contracts_template: [
      'interface UserService {',
      '    fun getUser(id: String): User',
      '    fun createUser(data: CreateUserInput): User',
      '}',
      '',
      'data class User(val id: String, val name: String)',
    ].join('\n'),
  },
};

const UNKNOWN_LANGUAGE: LanguageInfo = {
  id: 'unknown',
  name: 'Unknown',
  extensions: [],
  contracts_extension: '.txt',
  type_system: 'pseudo-code type definitions',
  contracts_template: [
    'type User:',
    '  id: string',
    '  name: string',
    '',
    'interface UserService:',
    '  getUser(id: string) -> User',
    '  createUser(data: CreateUserInput) -> User',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Extension → LanguageInfo lookup map
// ---------------------------------------------------------------------------

export const LANGUAGE_MAP: Record<string, LanguageInfo> = {};

for (const lang of Object.values(LANGUAGES)) {
  for (const ext of lang.extensions) {
    LANGUAGE_MAP[ext] = lang;
  }
}

// ---------------------------------------------------------------------------
// Directories and extensions to ignore during scanning
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'target',
  'build',
  'dist',
  '.lockstep',
  '.next',
  '.nuxt',
  'vendor',
  'venv',
  '.venv',
  'env',
]);

const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.md',
  '.txt',
  '.lock',
  '.cfg',
  '.ini',
  '.env',
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectProjectLanguage(
  workingDirectory: string,
): Promise<LanguageInfo> {
  const counts = new Map<string, number>();

  await scanDirectory(workingDirectory, counts, 0, 3);

  if (counts.size === 0) {
    return UNKNOWN_LANGUAGE;
  }

  // Find the extension with the highest count
  let maxExt = '';
  let maxCount = 0;
  for (const [ext, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxExt = ext;
    }
  }

  return LANGUAGE_MAP[maxExt] ?? UNKNOWN_LANGUAGE;
}

async function scanDirectory(
  dir: string,
  counts: Map<string, number>,
  depth: number,
  maxDepth: number,
): Promise<void> {
  if (depth >= maxDepth) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await scanDirectory(path.join(dir, entry.name), counts, depth + 1, maxDepth);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext && !CONFIG_EXTENSIONS.has(ext) && LANGUAGE_MAP[ext]) {
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lookup by id
// ---------------------------------------------------------------------------

export function getLanguageById(id: string): LanguageInfo {
  return LANGUAGES[id] ?? UNKNOWN_LANGUAGE;
}
