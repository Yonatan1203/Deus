import fs from 'fs';
import path from 'path';
import { parseEnvText } from './config.js';

/** Review roles that may get the GPT second opinion (diff reviews only). */
export const SECOND_OPINION_ROLES = new Set(['code-reviewer', 'ai-eng-warden']);
export const SECOND_OPINION_BACKEND = 'openai_compat';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface WardenInfo {
  name: string;
  enabled: boolean;
  tools: string[];
  backends?: string[];
  auto_threshold?: number;
  custom_instructions: string | null;
  rules_file: string | null;
  /** Present only on roles that may get the GPT second opinion. */
  second_opinion?: boolean;
}

type RawConfig = Record<string, Record<string, unknown>>;

function readJson(file: string): RawConfig | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as RawConfig;
  } catch {
    // missing or unreadable
  }
  return null;
}

/** The gitignored config.json the gate hooks read; {} when there is none. */
function readLive(wardensDir: string): { raw: RawConfig; exists: boolean } {
  const raw = readJson(path.join(wardensDir, 'config.json'));
  return { raw: raw ?? {}, exists: raw !== null };
}

/**
 * What the tab shows: every warden named in the example or in config.json,
 * config.json's values over the example's. The example's `backends` are left
 * out — the gate reads config.json only, so they would show a gate that does
 * not exist.
 */
function readMerged(wardensDir: string): RawConfig {
  const example = readJson(path.join(wardensDir, 'config.json.example')) ?? {};
  const { raw } = readLive(wardensDir);
  const out: RawConfig = {};
  for (const name of new Set([...Object.keys(example), ...Object.keys(raw)])) {
    const base = { ...(example[name] ?? {}) };
    delete base.backends;
    out[name] = { ...base, ...(raw[name] ?? {}) };
  }
  return out;
}

function rulesFileFor(name: string, files: string[]): string | null {
  const segs = name.split('-');
  const hit = (suffix: string) =>
    files.find((f) => f.endsWith(suffix) && segs.some((s) => f.startsWith(s)));
  return hit('-rules.md') ?? hit('-schema.md') ?? hit('.md') ?? null;
}

function toInfo(
  name: string,
  v: Record<string, unknown>,
  files: string[],
): WardenInfo {
  const info: WardenInfo = {
    name,
    enabled: v.enabled !== false,
    tools: Array.isArray(v.tools) ? v.tools.map(String) : [],
    custom_instructions:
      typeof v.custom_instructions === 'string' ? v.custom_instructions : null,
    rules_file: rulesFileFor(name, files),
  };
  if (Array.isArray(v.backends)) info.backends = v.backends.map(String);
  if (SECOND_OPINION_ROLES.has(name))
    info.second_opinion = (info.backends ?? []).includes(
      SECOND_OPINION_BACKEND,
    );
  if (typeof v.auto_threshold === 'number')
    info.auto_threshold = v.auto_threshold;
  return info;
}

function mdFiles(wardensDir: string): string[] {
  try {
    return fs
      .readdirSync(wardensDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return [];
  }
}

export function listWardens(wardensDir: string): WardenInfo[] {
  const raw = readMerged(wardensDir);
  const files = mdFiles(wardensDir);
  return Object.keys(raw)
    .sort()
    .map((name) => toInfo(name, raw[name] ?? {}, files));
}

/**
 * Sets one field of one warden in config.json and nothing else: the file is
 * never seeded from the example, whose `backends` would change every commit's
 * gate.
 */
function writeField(
  wardensDir: string,
  name: string,
  field: string,
  value: unknown,
): WardenInfo | null {
  if (!Object.prototype.hasOwnProperty.call(readMerged(wardensDir), name))
    return null;
  const { raw, exists } = readLive(wardensDir);
  raw[name] = { ...(raw[name] ?? {}), [field]: value };
  const target = path.join(wardensDir, 'config.json');
  if (exists) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(target, `${target}.bak-${stamp}`);
  }
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  return toInfo(name, readMerged(wardensDir)[name], mdFiles(wardensDir));
}

export function setWardenEnabled(
  wardensDir: string,
  name: string,
  enabled: boolean,
): WardenInfo | null {
  return writeField(wardensDir, name, 'enabled', enabled);
}

/**
 * Adds or removes the GPT second opinion on an allowed role. `claude` always
 * stays first; any other backends already listed are kept.
 */
export function setWardenSecondOpinion(
  wardensDir: string,
  name: string,
  on: boolean,
): WardenInfo | null {
  if (!SECOND_OPINION_ROLES.has(name)) return null;
  const current = readLive(wardensDir).raw[name]?.backends;
  const others = (Array.isArray(current) ? current.map(String) : []).filter(
    (b) => b !== 'claude' && b !== SECOND_OPINION_BACKEND,
  );
  const backends = [
    'claude',
    ...others,
    ...(on ? [SECOND_OPINION_BACKEND] : []),
  ];
  return writeField(wardensDir, name, 'backends', backends);
}

/** True when an executable named `codex` is on PATH. */
export function codexOnPath(envPath = process.env.PATH ?? ''): boolean {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, 'codex'), fs.constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * Why a role's gate cannot pass as configured, or null: a `gpt` backend needs
 * the codex CLI, and without it every commit waits for a verdict that never
 * comes.
 */
export function backendWarning(
  info: WardenInfo,
  hasCodex = codexOnPath(),
): string | null {
  return (info.backends ?? []).includes('gpt') && !hasCodex
    ? `${info.name} also lists the gpt backend, which needs the codex CLI (not installed here) — every commit will wait for it. Remove "gpt" from its backends in .claude/wardens/config.json.`
    : null;
}

/**
 * Whether the GPT reviewer is set up in the live .env, read as booleans plus
 * the model name — no value of any key ever leaves this function.
 */
export function secondOpinionStatus(envPath: string | undefined): {
  available: boolean;
  model: string | null;
} {
  if (!envPath) return { available: false, model: null };
  let text: string;
  try {
    text = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return { available: false, model: null };
  }
  const env = new Map<string, string>();
  for (const line of parseEnvText(text))
    if (line.key) env.set(line.key, line.value ?? '');
  const model = (env.get('WARDEN_OPENAI_COMPAT_MODEL') ?? '').trim();
  const base = (env.get('WARDEN_OPENAI_COMPAT_BASE_URL') ?? '')
    .trim()
    .replace(/\/+$/, '');
  const hasKey = (env.get('OPENAI_API_KEY') ?? '').trim().length > 0;
  return {
    available: base === OPENAI_BASE_URL && model.length > 0 && hasKey,
    model: model || null,
  };
}
