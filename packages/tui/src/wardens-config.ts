import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DEFAULT_DIR = join(REPO_ROOT, '.claude', 'wardens');

export interface WardenEntry {
  enabled: boolean;
  tools?: string[];
  auto_threshold?: number;
  custom_instructions?: string | null;
  [key: string]: unknown;
}

export type WardensConfig = Record<string, WardenEntry>;

export const WARDEN_DESCRIPTIONS: Record<string, string> = {
  'plan-reviewer':
    'Reviews plans against Deus-specific rules before source edits',
  'code-reviewer':
    'Reviews code changes for quality and security before commits',
  'threat-modeler':
    'STRIDE/OWASP threat review for auth, data, and trust boundaries',
  'architecture-snapshot':
    'Generates architecture overview with Mermaid diagrams',
  'session-retrospective':
    'Cross-session pattern analysis and retrospective reports',
  'data-quality': 'Reviews auto-memory files for retrieval quality',
};

export const WARDEN_TYPES: Record<string, string> = {
  'plan-reviewer': 'Validator (blocking)',
  'code-reviewer': 'Validator (blocking)',
  'threat-modeler': 'Validator (warning)',
  'architecture-snapshot': 'Generator',
  'session-retrospective': 'Generator',
  'data-quality': 'Validator (manual)',
};

export const BLOCKING_WARDENS = new Set(['plan-reviewer', 'code-reviewer']);

// The gate hooks read only config.json; a missing file or key means their own
// defaults. So the TUI never copies config.json.example into it (the example's
// `backends` would add a codex gate nothing here can pass) and a toggle writes
// just that warden's `enabled`.

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parsed JSON object, null when the file is absent; throws when unreadable or not an object. */
function readObject(file: string): Raw | null {
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isObject(data)) throw new Error(`${file} is not a JSON object`);
  return data;
}

function readExample(dir: string): Raw {
  try {
    return readObject(join(dir, 'config.json.example')) ?? {};
  } catch {
    return {}; // no usable example: config.json alone
  }
}

function view(example: Raw, live: Raw): WardensConfig {
  const out: WardensConfig = {};
  for (const name of new Set([...Object.keys(example), ...Object.keys(live)])) {
    const base: Raw = isObject(example[name]) ? { ...example[name] } : {};
    delete base.backends;
    const own = isObject(live[name]) ? live[name] : {};
    out[name] = { enabled: true, ...base, ...own } as WardenEntry;
  }
  return out;
}

/** What to show: the example's wardens with config.json's values over them. Never writes. */
export function loadWardensConfig(dir: string = DEFAULT_DIR): WardensConfig {
  let live: Raw;
  try {
    live = readObject(join(dir, 'config.json')) ?? {};
  } catch {
    return {}; // a broken config.json shows nothing rather than a made-up view
  }
  return view(readExample(dir), live);
}

/**
 * Sets one warden's `enabled` in config.json (read fresh) and returns the new
 * view. Throws for an unknown warden or an unreadable config.json, writing
 * nothing then.
 */
export function setWardenEnabled(
  name: string,
  enabled: boolean,
  dir: string = DEFAULT_DIR,
): WardensConfig {
  const file = join(dir, 'config.json');
  const live = readObject(file) ?? {}; // a broken file throws first, naming itself
  if (!Object.prototype.hasOwnProperty.call(view(readExample(dir), live), name))
    throw new Error(`Unknown warden: ${name}`);
  live[name] = { ...(isObject(live[name]) ? live[name] : {}), enabled };
  if (existsSync(file)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, '')
      .slice(0, 17);
    copyFileSync(file, `${file}.bak-${stamp}`);
  }
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(live, null, 2) + '\n', 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  return loadWardensConfig(dir);
}

export function triggersLabel(warden: WardenEntry, name: string): string {
  if (name === 'session-retrospective') {
    const threshold = warden.auto_threshold ?? 20;
    return `auto (threshold: ${threshold} sessions), manual`;
  }
  const tools = warden.tools;
  if (!tools || tools.length === 0) return 'manual';
  return tools.join(', ');
}
