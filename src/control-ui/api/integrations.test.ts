import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listIntegrations, setupPrompt } from './integrations.js';

const skill = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n# body\n`;
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, '.claude', 'skills', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'add-guardrails'), {
    recursive: true,
  });
  return root;
}

describe('listIntegrations', () => {
  it('reads add-* skills, classifies them, skips deprecated and empty folders', () => {
    const root = repo({
      'add-telegram/SKILL.md': skill(
        'add-telegram',
        'Add Telegram as a channel.',
      ),
      'add-linear/SKILL.md': skill('add-linear', 'Add Linear MCP.'),
      'add-foo/SKILL.md': skill('add-foo', 'Something new.'),
      'add-claude-context/SKILL.md': skill(
        'add-claude-context',
        '"[DEPRECATED] Replaced."',
      ),
      'debug/SKILL.md': skill('debug', 'Not an integration.'),
    });
    const list = listIntegrations(root, (k) => k === 'TELEGRAM_BOT_TOKEN');
    expect(list.map((i) => i.name)).toEqual([
      'add-foo',
      'add-linear',
      'add-telegram',
    ]);
    expect(list.find((i) => i.name === 'add-telegram')).toEqual({
      name: 'add-telegram',
      title: 'Telegram',
      kind: 'channel',
      description: 'Add Telegram as a channel.',
      needs: ['TELEGRAM_BOT_TOKEN'],
      configured: true,
    });
    expect(list.find((i) => i.name === 'add-linear')).toMatchObject({
      title: 'Linear',
      kind: 'mcp',
      needs: ['LINEAR_API_KEY'],
      configured: false,
    });
    expect(list.find((i) => i.name === 'add-foo')).toMatchObject({
      title: 'Foo',
      kind: 'other',
      needs: [],
      configured: null,
    });
  });
});

describe('setupPrompt', () => {
  it('is the skill line and the fixed note, naming the tab', () => {
    expect(setupPrompt('add-telegram', 'channel')).toBe(
      '/add-telegram\n' +
        "The operator started this from the dashboard's Channels tab. Walk them through the skill's steps here, one at a time, and say what each step changes. Ask before anything irreversible: replacing a channel or deleting files. If a token or key is needed, do not ask for its value here: name the key and the file (.env in this repo), ask the operator to add it themselves, then confirm it is set without printing it (grep -c '^VAR_NAME=' .env, with the real variable name). If the service must be restarted, make that the very last step, after your summary, and say that the dashboard will disconnect for a moment. When done, say what changed.",
    );
    expect(setupPrompt('add-linear', 'mcp')).toContain("dashboard's MCPs tab");
  });
});
