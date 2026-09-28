import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  registerTools,
  waitForResult,
  RESULTS_SUBDIR,
  type SkillMcpContext,
  type ToolServer,
} from './agent.js';

type Handler = (args: {
  post_id: string;
}) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

let ipcDir: string;
let tools: Record<string, Handler>;

function ctx(isMain = true): SkillMcpContext {
  return { groupFolder: 'main', chatJid: '1@g.us', isMain, ipcDir };
}

function server(): ToolServer {
  return {
    tool: (name, _desc, _schema, handler) => {
      tools[name] = handler as Handler;
    },
  };
}

function answer(requestId: string, result: object) {
  const dir = path.join(ipcDir, RESULTS_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${requestId}.json`), JSON.stringify(result));
}

function taskFiles(): Array<Record<string, string>> {
  const dir = path.join(ipcDir, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
}

beforeEach(() => {
  ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-publish-'));
  tools = {};
});
afterEach(() => {
  fs.rmSync(ipcDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('social-publish agent tools', () => {
  it('registers exactly the two tools', () => {
    registerTools(server(), ctx());
    expect(Object.keys(tools).sort()).toEqual([
      'social_publish_approved',
      'social_publish_preview',
    ]);
  });

  it('refuses outside the main group without writing any IPC file', async () => {
    registerTools(server(), ctx(false));
    const r = await tools.social_publish_approved({ post_id: 'IG1' });
    expect(r.isError).toBe(true);
    expect(taskFiles()).toEqual([]);
  });

  it('refuses malformed, multi, TikTok and traversal ids without writing any IPC file', async () => {
    registerTools(server(), ctx());
    for (const bad of ['IG1 IG2', 'all', 'TT1', 'IG1/../x', '', 'ig1']) {
      const r = await tools.social_publish_approved({ post_id: bad });
      expect(r.isError).toBe(true);
    }
    expect(taskFiles()).toEqual([]);
  });

  it('writes a typed task file and relays the host result for a preview', async () => {
    registerTools(server(), ctx());
    const p = tools.social_publish_preview({ post_id: 'IG1' });
    await new Promise((r) => setTimeout(r, 50));
    const [task] = taskFiles();
    expect(task.type).toBe('social_publish_preview');
    expect(task.postId).toBe('IG1');
    expect(task.requestId).toMatch(/^[a-z0-9-]{8,64}$/);
    answer(task.requestId, {
      success: true,
      message: 'Preview of IG1 sent to the group.',
    });
    const r = await p;
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('Preview of IG1');
  });

  it('relays a host refusal as an error for an approval request', async () => {
    registerTools(server(), ctx());
    const p = tools.social_publish_approved({ post_id: 'FB2' });
    await new Promise((r) => setTimeout(r, 50));
    const [task] = taskFiles();
    expect(task.type).toBe('social_publish_request');
    answer(task.requestId, {
      success: false,
      message: 'No founder approval message for FB2 in the last 15 min',
    });
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('No founder approval');
  });

  it('times out with a clear message when the host never answers', async () => {
    const r = await waitForResult(
      path.join(ipcDir, RESULTS_SUBDIR),
      'sp-never-answered',
      300,
      50,
    );
    expect(r).toEqual({
      success: false,
      message: 'Request timed out waiting for the host',
    });
  });

  it('consumes a malformed or wrongly-shaped result file and reports it as a failure', async () => {
    const dir = path.join(ipcDir, RESULTS_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sp-corrupt-0001.json'), '{not json');
    const r1 = await waitForResult(dir, 'sp-corrupt-0001', 300, 50);
    expect(r1.success).toBe(false);
    expect(r1.message).toMatch(/Failed to read result/);
    expect(fs.existsSync(path.join(dir, 'sp-corrupt-0001.json'))).toBe(false);
    fs.writeFileSync(
      path.join(dir, 'sp-badshape-001.json'),
      JSON.stringify({ ok: true }),
    );
    const r2 = await waitForResult(dir, 'sp-badshape-001', 300, 50);
    expect(r2).toEqual({
      success: false,
      message: 'Host returned an invalid result',
    });
    expect(fs.existsSync(path.join(dir, 'sp-badshape-001.json'))).toBe(false);
  });
});
