import fs from 'fs';
import path from 'path';

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  explores_code?: boolean;
  color?: string;
  version?: string;
  linear_label?: string;
  file: string;
}

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => String(scalar(s)))
      .filter(Boolean);
  }
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** Minimal YAML subset used by .claude/agents: scalars, inline lists, block lists. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2] === '' ? [] : scalar(kv[2]);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key && Array.isArray(out[key])) {
      (out[key] as unknown[]).push(scalar(item[1]));
      continue;
    }
    if (key && typeof out[key] === 'string' && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`;
    }
  }
  return out;
}

const STRING_FIELDS = ['model', 'color', 'version', 'linear_label'] as const;

export function listAgents(agentsDir: string): AgentInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const fm = parseFrontmatter(
      fs.readFileSync(path.join(agentsDir, e.name), 'utf-8'),
    );
    if (typeof fm.name !== 'string') continue;
    const a: AgentInfo = {
      name: fm.name,
      description: typeof fm.description === 'string' ? fm.description : '',
      file: e.name,
    };
    for (const f of STRING_FIELDS) {
      if (typeof fm[f] === 'string') a[f] = fm[f] as string;
    }
    if (typeof fm.explores_code === 'boolean')
      a.explores_code = fm.explores_code;
    if (Array.isArray(fm.tools)) a.tools = fm.tools.map(String);
    agents.push(a);
  }
  return agents.sort((x, y) => x.name.localeCompare(y.name));
}
