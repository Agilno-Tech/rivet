import { pathToFileURL } from 'node:url';

const repository = 'Agilno-Tech/rivet';
// Release Please includes the package component in PR branches even when tags omit it.
const releaseBranch = 'release-please--branches--main--components--rivet';
const activeStatuses = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

function trustedPullRequest(pr) {
  return pr?.state === 'open' && pr.base?.ref === 'main'
    && pr.base.repo?.full_name === repository && pr.head?.repo?.full_name === repository
    && pr.head.ref === releaseBranch && /^[a-f0-9]{40}$/.test(pr.head.sha)
    && pr.user?.login === 'github-actions[bot]'
    && pr.labels?.some(label => label.name === 'autorelease: pending');
}

export async function dispatchReleaseWorkflows({ env = process.env, request } = {}) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Release dispatch only runs from Agilno-Tech/rivet main.');
  }
  if (!request) {
    if (!env.GH_TOKEN) throw new Error('GitHub workflow token is required.');
    request = async (method, resource, body) => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${resource}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`GitHub ${method} ${resource.split('?')[0]} failed (${response.status}).`);
      return response.status === 204 ? null : response.json();
    };
  }
  const dispatched = [];
  let prs;
  if (env.RELEASE_PR) {
    const output = JSON.parse(env.RELEASE_PR);
    if (!Number.isSafeInteger(output.number) || output.number <= 0) throw new Error('Invalid release PR output.');
    prs = [await request('GET', `pulls/${output.number}`)];
    if (!trustedPullRequest(prs[0])) throw new Error('Release PR does not match the trusted bot branch.');
  } else {
    // Also recover a previous run that created a PR but failed before CI dispatch.
    prs = await request('GET', `pulls?state=open&base=main&head=Agilno-Tech:${releaseBranch}&per_page=100`);
    prs = prs.filter(trustedPullRequest);
  }
  if (prs.length > 1) throw new Error('More than one release PR matched.');
  for (const pr of prs) {
    for (const workflow of ['ci.yml', 'docs.yml']) {
      const runs = await request('GET', `actions/workflows/${workflow}/runs?head_sha=${pr.head.sha}&per_page=100`);
      const alreadyVerified = runs.workflow_runs.some(run => run.event === 'workflow_dispatch' && run.head_sha === pr.head.sha
        && run.head_branch === releaseBranch
        && (activeStatuses.has(run.status) || run.conclusion === 'success'));
      if (alreadyVerified) continue;
      const current = await request('GET', `pulls/${pr.number}`);
      if (!trustedPullRequest(current) || current.head.sha !== pr.head.sha) {
        throw new Error('Release PR changed before verification dispatch; rerun release preparation.');
      }
      await request('POST', `actions/workflows/${workflow}/dispatches`, {
        ref: releaseBranch,
        ...(workflow === 'docs.yml' ? { inputs: { publish: 'false' } } : {}),
      });
      dispatched.push(workflow);
    }
  }
  return dispatched;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatchReleaseWorkflows().then(workflows => {
    console.log(workflows.length ? `Dispatched: ${workflows.join(', ')}` : 'No release workflows need dispatch.');
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
