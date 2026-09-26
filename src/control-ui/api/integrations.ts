import path from 'path';
import { readSkillDir } from './claude-commands.js';

// The integrations this repo can add: its own `/add-<name>` skills, with a
// fixed table saying what kind each is and which env keys signal "set up".
// Only key names ever leave this module — never values.

export type IntegrationKind = 'channel' | 'mcp' | 'tool' | 'backend' | 'other';

export interface Integration {
  name: string;
  title: string;
  kind: IntegrationKind;
  description: string;
  needs: string[];
  configured: boolean | null;
}

export const INTEGRATION_NAME_RE = /^add-[a-z0-9-]{1,40}$/;

const KINDS: Record<
  string,
  { kind: IntegrationKind; title: string; needs?: string[] }
> = {
  'add-whatsapp': { kind: 'channel', title: 'WhatsApp' },
  'add-telegram': {
    kind: 'channel',
    title: 'Telegram',
    needs: ['TELEGRAM_BOT_TOKEN'],
  },
  'add-telegram-swarm': {
    kind: 'channel',
    title: 'Telegram agent swarm',
    needs: ['TELEGRAM_BOT_TOKEN'],
  },
  'add-discord': {
    kind: 'channel',
    title: 'Discord',
    needs: ['DISCORD_BOT_TOKEN'],
  },
  'add-slack': {
    kind: 'channel',
    title: 'Slack',
    needs: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  },
  'add-msft-teams': {
    kind: 'channel',
    title: 'Microsoft Teams',
    needs: ['TEAMS_APP_ID'],
  },
  'add-linear': { kind: 'mcp', title: 'Linear', needs: ['LINEAR_API_KEY'] },
  'add-asana': { kind: 'mcp', title: 'Asana', needs: ['ASANA_ACCESS_TOKEN'] },
  'add-parallel': {
    kind: 'mcp',
    title: 'Parallel AI research',
    needs: ['PARALLEL_API_KEY'],
  },
  'add-youtube-transcript': { kind: 'mcp', title: 'YouTube transcripts' },
  'add-ollama-tool': { kind: 'mcp', title: 'Ollama (local models)' },
  'add-gcal': { kind: 'tool', title: 'Google Calendar' },
  'add-gmail': { kind: 'tool', title: 'Gmail' },
  'add-outlook': { kind: 'tool', title: 'Outlook' },
  'add-image-vision': { kind: 'tool', title: 'Image vision' },
  'add-pdf-reader': { kind: 'tool', title: 'PDF reading' },
  'add-voice-transcription': {
    kind: 'tool',
    title: 'Voice transcription',
    needs: ['OPENAI_API_KEY'],
  },
  'add-reactions': { kind: 'tool', title: 'WhatsApp reactions' },
  'add-codex': {
    kind: 'backend',
    title: 'OpenAI / Codex backend',
    needs: ['OPENAI_API_KEY'],
  },
  'add-connector': { kind: 'backend', title: 'Model connector' },
  'add-llama-cpp': { kind: 'backend', title: 'llama.cpp (local)' },
};

const titleOf = (name: string) =>
  name
    .replace(/^add-/, '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

export function listIntegrations(
  repoRoot: string,
  envHas: (key: string) => boolean,
): Integration[] {
  return readSkillDir(path.join(repoRoot, '.claude', 'skills'), 'project')
    .filter(
      (s) =>
        INTEGRATION_NAME_RE.test(s.name) &&
        !s.description.replace(/^["']/, '').startsWith('[DEPRECATED]'),
    )
    .map((s) => {
      const k = KINDS[s.name];
      const needs = k?.needs ?? [];
      return {
        name: s.name,
        title: k?.title ?? titleOf(s.name),
        kind: k?.kind ?? 'other',
        description: s.description,
        needs,
        configured: needs.length ? needs.every(envHas) : null,
      };
    });
}

/** The session's first message: the skill, then how to run it for someone watching from the dashboard. */
export function setupPrompt(name: string, kind: IntegrationKind): string {
  const tab = kind === 'channel' ? 'Channels' : 'MCPs';
  return (
    `/${name}\n` +
    `The operator started this from the dashboard's ${tab} tab. Walk them through the skill's steps here, one at a time, and say what each step changes. Ask before anything irreversible: replacing a channel or deleting files. If a token or key is needed, do not ask for its value here: name the key and the file (.env in this repo), ask the operator to add it themselves, then confirm it is set without printing it (grep -c '^VAR_NAME=' .env, with the real variable name). If the service must be restarted, make that the very last step, after your summary, and say that the dashboard will disconnect for a moment. When done, say what changed.`
  );
}
