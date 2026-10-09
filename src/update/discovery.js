import { join, isAbsolute, relative } from 'node:path';
import { CliError } from '../cli/output.js';
export const PACKAGE_NAME = '@agilno-tech/rivet';
export const REGISTRY = 'https://registry.npmjs.org/';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const validVersion = value => typeof value === 'string' && value.length <= 128 && VERSION.test(value);
export function packageMetadata(root, fs) {
  try {
    const file = join(root, 'package.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error();
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pkg.name !== PACKAGE_NAME || !validVersion(pkg.version) || pkg.private === true) throw new Error();
    return { name: pkg.name, version: pkg.version };
  } catch { throw new CliError('Installed Rivet package metadata is invalid.', 'MISSING_CONFIGURATION'); }
}
export async function fetchLatestVersion(fetcher) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(`${REGISTRY}${encodeURIComponent(PACKAGE_NAME)}/latest`, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || Number(response.headers?.get?.('content-length')) > 65536) throw new Error();
    if (!response.body?.getReader) throw new Error();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 65536) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.name !== PACKAGE_NAME || !validVersion(data.version)) throw new Error();
    return data.version;
  } catch { throw new CliError('Could not read valid latest-version metadata from the npm registry. No update was performed.', 'PROVIDER_UNAVAILABLE'); }
  finally { clearTimeout(timeout); }
}
function line(result) {
  if (result?.code !== 0 || result.timedOut || result.truncated?.stdout) return null;
  const value = result.stdout?.trim();
  return typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value) ? value : null;
}
export async function discoverInstallation(packageRoot, { fs, runner, cwd, env }) {
  const actual = fs.realpathSync(packageRoot), matches = [];
  const query = async (manager, args) => {
    try { return line(await runner(manager, args, { cwd, env, shell:false, timeoutMs:5000, maxOutputBytes:8192 })); }
    catch { return null; }
  };
  // Canonical package identity distinguishes npm, Yarn Classic and pnpm, including pnpm's symlinked store.
  for (const manager of ['npm','yarn','pnpm']) {
    if (manager === 'yarn' && !/^1\./.test(await query('yarn',['--version']) ?? '')) continue;
    const root = await query(manager, manager === 'yarn' ? ['global','dir','--silent'] : ['root','--global']);
    if (!root || !isAbsolute(root)) continue;
    const candidate = join(root, ...(manager === 'yarn' ? ['node_modules'] : []), '@agilno-tech','rivet');
    try {
      const managerRoot=fs.realpathSync(manager==='yarn'?join(root,'node_modules'):root);
      const pathFromRoot=relative(managerRoot,actual);
      const owned=manager==='pnpm'
        ? pathFromRoot!=='' && pathFromRoot!=='..' && !pathFromRoot.startsWith('../') && !isAbsolute(pathFromRoot)
        : actual===join(managerRoot,'@agilno-tech','rivet');
      if (owned && fs.realpathSync(candidate) === actual) matches.push({manager,packageRoot:actual,lookupPath:candidate});
    } catch {}
  }
  if (matches.length !== 1 || fs.existsSync(join(actual,'.git'))) {
    throw new CliError('Cannot safely identify the package manager owning this Rivet installation. Update with the original package manager, or use rivet update --project. Source and ambiguous installations are not changed.', 'REPOSITORY_CONFLICT');
  }
  return matches[0];
}
export function globalUpdateArgs(manager, version) {
  const spec = `${PACKAGE_NAME}@${version}`;
  if (manager === 'npm') return ['install','--global',spec,'--ignore-scripts','--no-audit','--no-fund',`--registry=${REGISTRY}`];
  if (manager === 'yarn') return ['global','add',spec,'--ignore-scripts','--non-interactive',`--registry=${REGISTRY}`];
  if (manager === 'pnpm') return ['add','--global',spec,'--ignore-scripts',`--registry=${REGISTRY}`];
  throw new TypeError('Unsupported package manager');
}
