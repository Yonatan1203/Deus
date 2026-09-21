import fs from 'fs';
import path from 'path';

export interface WardenInfo {
  name: string;
  enabled: boolean;
  tools: string[];
  backends?: string[];
  auto_threshold?: number;
  custom_instructions: string | null;
  rules_file: string | null;
}

type RawConfig = Record<string, Record<string, unknown>>;

function readConfig(wardensDir: string): {
  raw: RawConfig;
  fromExample: boolean;
} {
  const candidates = [
    ['config.json', false],
    ['config.json.example', true],
  ] as const;
  for (const [file, fromExample] of candidates) {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(wardensDir, file), 'utf-8'),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { raw: parsed as RawConfig, fromExample };
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return { raw: {}, fromExample: true };
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
  const { raw } = readConfig(wardensDir);
  const files = mdFiles(wardensDir);
  return Object.keys(raw)
    .sort()
    .map((name) => toInfo(name, raw[name] ?? {}, files));
}

export function setWardenEnabled(
  wardensDir: string,
  name: string,
  enabled: boolean,
): WardenInfo | null {
  const { raw, fromExample } = readConfig(wardensDir);
  if (!Object.prototype.hasOwnProperty.call(raw, name)) return null;
  raw[name] = { ...raw[name], enabled };
  const target = path.join(wardensDir, 'config.json');
  if (!fromExample) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(target, `${target}.bak-${stamp}`);
  }
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  return toInfo(name, raw[name], mdFiles(wardensDir));
}
