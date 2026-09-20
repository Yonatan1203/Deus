import fs from 'fs';
import path from 'path';

export interface McpInventory {
  container: {
    name: string;
    source: string;
    conditional: boolean;
    available: boolean;
  }[];
  skills: { name: string; dir: string; has_test: boolean }[];
  channels: { package: string; built: boolean; configured: boolean | null }[];
}

const exists = (...p: string[]) => fs.existsSync(path.join(...p));

// How each channel package signals "credentials present" — mirrors what the
// channel factories in src/channels/mcp-*.ts check before they start.
const CHANNEL_CONFIGURED: Record<
  string,
  (root: string, envHas: (k: string) => boolean) => boolean
> = {
  'mcp-whatsapp': (root) => exists(root, 'store', 'auth', 'creds.json'),
  'mcp-telegram': (_r, envHas) => envHas('TELEGRAM_BOT_TOKEN'),
  'mcp-discord': (_r, envHas) => envHas('DISCORD_BOT_TOKEN'),
  'mcp-slack': (_r, envHas) => envHas('SLACK_BOT_TOKEN'),
  'mcp-teams': (_r, envHas) => envHas('TEAMS_APP_ID'),
  'mcp-x': (_r, envHas) => envHas('X_API_KEY'),
};

export function listMcps(
  repoRoot: string,
  envHas: (key: string) => boolean,
): McpInventory {
  const container: McpInventory['container'] = [
    {
      name: 'deus',
      source: 'container/agent-runner (ipc-mcp-stdio)',
      conditional: false,
      available: true,
    },
    {
      name: 'gcal',
      source: 'packages/mcp-gcal',
      conditional: true,
      available:
        exists(repoRoot, 'packages', 'mcp-gcal', 'dist', 'index.js') &&
        exists(repoRoot, 'integrations', 'gcal', 'credentials.json') &&
        exists(repoRoot, 'integrations', 'gcal', 'tokens.json'),
    },
    {
      name: 'linear',
      source: '@tacticlaunch/mcp-linear (container image)',
      conditional: true,
      available: envHas('LINEAR_API_KEY'),
    },
  ];

  const skillsDir = path.join(
    repoRoot,
    'container',
    'agent-runner',
    'src',
    'skills',
  );
  let skills: McpInventory['skills'];
  try {
    skills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && exists(skillsDir, d.name, 'agent.ts'))
      .map((d) => ({
        name: d.name,
        dir: path.posix.join(
          'container',
          'agent-runner',
          'src',
          'skills',
          d.name,
        ),
        has_test: exists(skillsDir, d.name, 'agent.test.ts'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    skills = [];
  }

  const pkgDir = path.join(repoRoot, 'packages');
  let channels: McpInventory['channels'];
  try {
    channels = fs
      .readdirSync(pkgDir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          d.name.startsWith('mcp-') &&
          d.name !== 'mcp-channel-core',
      )
      .map((d) => ({
        package: d.name,
        built: exists(pkgDir, d.name, 'dist', 'index.js'),
        configured: CHANNEL_CONFIGURED[d.name]?.(repoRoot, envHas) ?? null,
      }))
      .sort((a, b) => a.package.localeCompare(b.package));
  } catch {
    channels = [];
  }

  return { container, skills, channels };
}
