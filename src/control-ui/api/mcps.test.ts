import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listMcps } from './mcps.js';

describe('control-ui mcps', () => {
  it('inventories container, skill and channel MCPs from the filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcps-'));
    const mk = (p: string) => {
      fs.mkdirSync(path.join(root, path.dirname(p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), '');
    };
    mk('packages/mcp-gcal/dist/index.js');
    mk('packages/mcp-telegram/dist/index.js');
    mk('packages/mcp-x/package.json');
    mk('packages/mcp-channel-core/package.json');
    mk('container/agent-runner/src/skills/social-publish/agent.ts');
    mk('container/agent-runner/src/skills/social-publish/agent.test.ts');
    mk('store/auth/creds.json');
    mk('packages/mcp-whatsapp/dist/index.js');
    const inv = listMcps(root, (k) => k === 'TELEGRAM_BOT_TOKEN');
    expect(inv.container.map((c) => [c.name, c.available])).toEqual([
      ['deus', true],
      ['gcal', false],
      ['linear', false],
    ]);
    expect(inv.skills).toEqual([
      {
        name: 'social-publish',
        dir: 'container/agent-runner/src/skills/social-publish',
        has_test: true,
      },
    ]);
    expect(inv.channels).toEqual([
      { package: 'mcp-gcal', built: true, configured: null },
      { package: 'mcp-telegram', built: true, configured: true },
      { package: 'mcp-whatsapp', built: true, configured: true },
      { package: 'mcp-x', built: false, configured: false },
    ]);
  });
});
