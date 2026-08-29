/**
 * OpenAI-via-credential-proxy capability note.
 *
 * On the Claude backend the host injects `OPENAI_BASE_URL` (pointing at the
 * credential proxy's `/openai` route) only for normal groups when the host
 * holds an OpenAI key (container-runner.ts). The proxy swaps the placeholder
 * for the real key, so the container can reach OpenAI's image and audio
 * endpoints without ever seeing a credential. This appends a short, static
 * recipe so the agent knows the route exists. Pure module, mirroring
 * `subagentNudgeAppend`.
 */

export const OPENAI_PROXY_NUDGE = `## OpenAI image generation and audio transcription

OpenAI's image and audio APIs are reachable through the Deus credential proxy at
$OPENAI_BASE_URL (already set in your environment). No API key is needed or
available — the proxy injects it. Every request MUST carry the header
"x-deus-proxy-token: $DEUS_PROXY_TOKEN". Use curl (the openai SDKs are not
installed), e.g.:

  curl -s "$OPENAI_BASE_URL/v1/images/generations" \\
    -H "x-deus-proxy-token: $DEUS_PROXY_TOKEN" -H "content-type: application/json" \\
    -d '{"model":"gpt-image-1","prompt":"...","size":"1024x1024","n":1}'
  # response: data[0].b64_json → decode to a file under /workspace/group/

  curl -s "$OPENAI_BASE_URL/v1/images/edits" -H "x-deus-proxy-token: $DEUS_PROXY_TOKEN" \\
    -F model=gpt-image-1 -F "image[]=@ref.png" -F prompt="..."

  curl -s "$OPENAI_BASE_URL/v1/audio/transcriptions" -H "x-deus-proxy-token: $DEUS_PROXY_TOKEN" \\
    -F file=@recording.m4a -F model=gpt-4o-transcribe

Limits: request bodies up to 32 MB; audio files up to 25 MB (split longer
recordings). These calls are metered — confirm cost with the user before large
batches, and never paste credentials or the proxy token into chat output.`;

export interface OpenAIProxyNudgeOpts {
  /** OPENAI_BASE_URL as injected by the host; undefined/empty when no route. */
  openaiBaseUrl: string | undefined;
  /** DEUS_PROXY_TOKEN present — required to authenticate to the proxy. */
  hasProxyToken: boolean;
  /** Tool profile: 'webhook' runs have no Bash/curl (LIA-315). */
  toolProfile: 'full' | 'webhook';
}

/**
 * Returns the nudge text when it should be appended, else an empty string.
 *
 * Appended only when ALL hold:
 *  - `openaiBaseUrl`  — the host advertised the route (normal group + host key)
 *  - `hasProxyToken`  — the container can authenticate to the proxy
 *  - `toolProfile === 'full'` — the webhook profile cannot run curl at all
 */
export function openaiProxyAppend(opts: OpenAIProxyNudgeOpts): string {
  const { openaiBaseUrl, hasProxyToken, toolProfile } = opts;
  if (!openaiBaseUrl || !hasProxyToken || toolProfile !== 'full') return '';
  return OPENAI_PROXY_NUDGE;
}
