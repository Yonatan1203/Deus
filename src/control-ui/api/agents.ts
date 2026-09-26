import fs from 'fs';
import path from 'path';
import { redactSecrets } from './logs.js';

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

export interface AgentDetail extends AgentInfo {
  body: string;
  truncated: boolean;
}

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const AGENT_BODY_MAX = 128 * 1024;

/** The text after the frontmatter. */
function bodyOf(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return text;
  const end = lines.indexOf('---', 1);
  return end === -1
    ? ''
    : lines
        .slice(end + 1)
        .join('\n')
        .replace(/^\n+/, '');
}

/**
 * One agent, found by its frontmatter name, read only when it is a plain file
 * directly inside the agents folder. The body is redacted and cut at 128 KiB
 * (on a character boundary).
 */
export function readAgent(agentsDir: string, name: string): AgentDetail | null {
  if (!AGENT_NAME_RE.test(name)) return null;
  const info = listAgents(agentsDir).find((a) => a.name === name);
  if (!info) return null;
  let root: string;
  try {
    root = fs.realpathSync(agentsDir);
  } catch {
    return null;
  }
  const file = path.join(agentsDir, info.file);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    if (path.dirname(fs.realpathSync(file)) !== root) return null;
  } catch {
    return null;
  }
  const raw = Buffer.from(bodyOf(fs.readFileSync(file, 'utf-8')), 'utf-8');
  const truncated = raw.length > AGENT_BODY_MAX;
  const body = truncated
    ? raw
        .subarray(0, AGENT_BODY_MAX)
        .toString('utf-8')
        .replace(/\uFFFD+$/, '')
    : raw.toString('utf-8');
  return { ...info, body: redactSecrets(body), truncated };
}
