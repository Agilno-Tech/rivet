import { ProviderAdapterError } from '../adapters/contract.js';
import { CliError } from './output.js';

const NAMES = Object.freeze({github:'GitHub',bitbucket:'Bitbucket Cloud',gitlab:'GitLab',jira:'Jira',linear:'Linear',confluence:'Confluence',figma:'Figma'});

// Only trusted, fixed adapter metadata crosses the CLI boundary, never response
// bodies, headers, URLs, raw transport errors or credential values.
export function providerCliError(error) {
  if (!(error instanceof ProviderAdapterError) || !['ERR_PROVIDER_REMOTE','ERR_PROVIDER_TRANSPORT','ERR_PROVIDER_TIMEOUT','ERR_PROVIDER_ABORTED','ERR_PROVIDER_DNS_UNSAFE','ERR_PROVIDER_RESPONSE_TOO_LARGE'].includes(error.code)) return error;
  const provider = NAMES[error.provider] ?? 'Provider';
  const status = error.status === undefined ? '' : ` (HTTP ${error.status})`;
  const guidance = error.status === 401
    ? 'Replace the configured token with a complete, unexpired Bearer token supported by this provider, then retry. Check that pasting did not truncate it.'
    : error.status === 403
      ? 'Check token scopes and access to the selected repository and pull requests, then retry.'
      : error.status === 429
        ? 'Wait for the provider rate limit to reset, then retry.'
        : 'Check provider availability, token access and the selected resource, then retry.';
  return new CliError(`${provider} request failed${status}.\nNext: ${guidance}`, 'PROVIDER_UNAVAILABLE', {cause:error});
}
