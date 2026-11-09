import { createProviderHttpClient } from '../adapters/http.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { ProviderAdapterError } from '../adapters/contract.js';
import { repositoryHeaders } from '../commands/repositories.js';
import { parseRepositoryRemote } from '../repositories/identity.js';

const ENDPOINTS = Object.freeze({
  'https://api.github.com': {provider:'github',host:'github.com'},
  'https://api.bitbucket.org/2.0': {provider:'bitbucket',host:'bitbucket.org'},
  'https://gitlab.com/api/v4': {provider:'gitlab',host:'gitlab.com'},
});

function targetFor(row, config) {
  const endpoint = row.endpoint?.replace(/\/$/, '');
  const service = ENDPOINTS[endpoint];
  if (row.kind !== 'git-ci' || !service || !row.capabilities.includes('repository-read')) return null;
  let repository;
  const saved = config.project.repository?.remote?.url;
  if (saved) {
    try { repository = parseRepositoryRemote(saved); } catch { return null; }
    if (repository.provider !== service.provider
      || (row.resourceIds?.length && !row.resourceIds.includes(repository.fullName))) return null;
  } else {
    if (row.resourceIds?.length !== 1) return null;
    try { repository = parseRepositoryRemote(`https://${service.host}/${row.resourceIds[0]}`); } catch { return null; }
    // Do not let normalization turn a configured resource into another resource.
    if (repository.fullName !== row.resourceIds[0]) return null;
  }
  const name = repository.fullName;
  const path = service.provider === 'github' ? `/repos/${name}/pulls?per_page=1`
    : service.provider === 'bitbucket' ? `/repositories/${name}/pullrequests?pagelen=1`
      : `/projects/${encodeURIComponent(name)}/merge_requests?per_page=1`;
  return {provider:service.provider,baseUrl:endpoint,path};
}

/** Exactly one bounded GET per supported, scoped repository integration. No retries or pagination. */
export async function checkLiveIntegrations(rows, config, dependencies = {}) {
  const environment = dependencies.env ?? process.env;
  const timeoutMs = dependencies.integrationProbeTimeoutMs ?? 3_000;
  const results = await Promise.all(rows.map(async row => {
    const skipped = remedy => ({...row,live:{status:'not_checked',networkChecked:false,remedy}});
    if (row.transport !== 'direct-api' || row.readiness !== 'credentials-present') return skipped(row.remedy);
    const target = targetFor(row, config);
    if (!target) return skipped('Live checks support GitHub.com, Bitbucket Cloud and GitLab.com repository-read providers. Configure a matching saved repository remote or one repository resourceIds entry.');
    let headers;
    try { headers = repositoryHeaders(row, environment); }
    catch { return skipped('Configure one valid token environment reference and set its complete value.'); }
    try {
      const client = createProviderHttpClient({provider:target.provider,baseUrl:target.baseUrl,headers,
        transport:dependencies.repositories?.transport ?? createNodeProviderTransport(),timeoutMs,
        maxResponseBytes:64*1024,allowEncodedSlash:true});
      const response = await client.request({method:'GET',path:target.path});
      return {...row,live:{status:'ok',httpStatus:response.status,networkChecked:true,
        remedy:'Read access to the probed pull/merge-request endpoint succeeded. This does not verify every scope or write permission.'}};
    } catch (error) {
      const trusted = error instanceof ProviderAdapterError;
      const httpStatus = trusted ? error.status : undefined;
      const status = httpStatus === 401 ? 'rejected' : httpStatus === 403 ? 'insufficient_scope'
        : trusted && error.code === 'ERR_PROVIDER_TIMEOUT' ? 'timeout' : 'unavailable';
      const remedy = status === 'rejected' ? 'Set a complete, unexpired Bearer token supported by the provider. Check for truncation when pasting.'
        : status === 'insufficient_scope' ? 'Check read scopes and repository access. HTTP 403 can also indicate an account or organization access restriction.'
          : httpStatus === 404 ? 'Check repository identity and access; HTTP 404 can hide an inaccessible private repository.'
            : httpStatus === 429 ? 'Wait for the provider rate limit to reset and retry.'
              : 'Check connectivity and provider availability, then retry.';
      return {...row,live:{status,...(httpStatus === undefined ? {} : {httpStatus}),networkChecked:true,remedy}};
    }
  }));
  return {integrations:results,networkChecked:results.some(row=>row.live.networkChecked)};
}
