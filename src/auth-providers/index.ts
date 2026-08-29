/**
 * Auth provider barrel export.
 *
 * Does NOT auto-register providers at import time — that would break test
 * mocks because readEnvFile would be called before vi.mock() takes effect.
 * Instead, call ensureDefaultProviders() to lazily register built-in providers.
 */

export type { AuthProvider } from './types.js';
export { AuthProviderRegistry, NoProviderAvailableError } from './types.js';
export {
  AnthropicAuthProvider,
  CREDENTIALS_PATH,
  triggerProactiveOAuthRefresh,
  _resetCredentialsCacheForTest,
} from './anthropic.js';
export { OpenAIAuthProvider } from './openai.js';

import { AuthProviderRegistry } from './types.js';
import { AnthropicAuthProvider } from './anthropic.js';
import { OpenAIAuthProvider } from './openai.js';

/**
 * Ensure the default Anthropic provider is registered.
 * Safe to call multiple times — skips if already registered.
 */
/**
 * Whether the credential proxy can serve `/openai/*` — i.e. the host holds
 * OpenAI credentials. Used by container-runner to decide whether to advertise
 * the route (`OPENAI_BASE_URL`) to normal-group containers on the Claude
 * backend. Never exposes the secret itself.
 */
export function hasOpenAIProxyCredentials(): boolean {
  ensureDefaultProviders();
  try {
    return AuthProviderRegistry.default().get('openai').isAvailable();
  } catch {
    return false;
  }
}

export function ensureDefaultProviders(): void {
  const registry = AuthProviderRegistry.default();
  if (!registry.listProviders().includes('anthropic')) {
    registry.register(new AnthropicAuthProvider());
  }
  if (!registry.listProviders().includes('openai')) {
    registry.register(new OpenAIAuthProvider());
  }
}
