import { describe, expect, it } from 'vitest';

import { OPENAI_PROXY_NUDGE, openaiProxyAppend } from './openai-proxy-nudge.js';

const on = {
  openaiBaseUrl: 'http://host.docker.internal:3001/openai',
  hasProxyToken: true,
  toolProfile: 'full' as const,
};

describe('openaiProxyAppend', () => {
  it('appends the recipe when the route, token and full profile are all present', () => {
    expect(openaiProxyAppend(on)).toBe(OPENAI_PROXY_NUDGE);
  });

  it('is silent when the host did not advertise the route', () => {
    expect(openaiProxyAppend({ ...on, openaiBaseUrl: undefined })).toBe('');
    expect(openaiProxyAppend({ ...on, openaiBaseUrl: '' })).toBe('');
  });

  it('is silent without a proxy token', () => {
    expect(openaiProxyAppend({ ...on, hasProxyToken: false })).toBe('');
  });

  it('is silent for the webhook profile (no Bash/curl available)', () => {
    expect(openaiProxyAppend({ ...on, toolProfile: 'webhook' })).toBe('');
  });

  it('teaches the proxy-token header and never embeds a literal secret', () => {
    expect(OPENAI_PROXY_NUDGE).toContain(
      'x-deus-proxy-token: $DEUS_PROXY_TOKEN',
    );
    expect(OPENAI_PROXY_NUDGE).toContain(
      '$OPENAI_BASE_URL/v1/images/generations',
    );
    expect(OPENAI_PROXY_NUDGE).toContain(
      '$OPENAI_BASE_URL/v1/audio/transcriptions',
    );
    expect(OPENAI_PROXY_NUDGE).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});
