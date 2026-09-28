/**
 * Container-side skill MCP tool registry.
 *
 * At startup, scans <compiled-dir>/skills/{name}/agent.js for skill MCP tool
 * definitions. Each agent.js must export a `registerTools` function that
 * receives the MCP server instance and a context object.
 *
 * Skill agent files are copied into the container at build time from
 * .claude/skills/{name}/agent.ts into /app/src/skills/{name}/, and the
 * container entrypoint's tsc step compiles them alongside the agent-runner
 * source (into /tmp/dist/skills/{name}/agent.js at runtime). The scan
 * directory is therefore resolved relative to THIS compiled module, not
 * hardcoded: a fixed `/app/skills` never exists in the image, which silently
 * loaded zero skill tools.
 *
 * This enables community-contributed MCP tool templates that extend the
 * agent's capabilities without modifying ipc-mcp-stdio.ts.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export interface SkillMcpContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  ipcDir: string;
}

export type RegisterToolsFn = (server: McpServer, ctx: SkillMcpContext) => void;

/** Default scan root: the `skills/` directory next to this compiled module. */
export function defaultSkillsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'skills');
}

export async function loadSkillMcpTools(
  server: McpServer,
  ctx: SkillMcpContext,
  skillsDir: string = defaultSkillsDir(),
): Promise<void> {
  if (!fs.existsSync(skillsDir)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const agentPath = path.join(skillsDir, entry.name, 'agent.js');
    if (!fs.existsSync(agentPath)) continue;

    try {
      // file URL: a bare absolute path is not a valid ESM specifier on every platform.
      const mod = await import(pathToFileURL(agentPath).href);
      if (typeof mod.registerTools === 'function') {
        mod.registerTools(server, ctx);
        console.error(`[skill-mcp] Loaded tools from skill: ${entry.name}`);
      }
    } catch (err) {
      console.error(`[skill-mcp] Failed to load skill ${entry.name}: ${err}`);
    }
  }
}
