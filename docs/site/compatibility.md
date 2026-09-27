# Compatibility

Rivet is an alpha. Use this page to check your environment and understand where testing is still incomplete.

## Runtime and installation

| Environment | Support and testing |
| --- | --- |
| macOS and Linux, Node 22 or 24 | CI covers the regression suite and installed-package lifecycle. |
| Native Windows | Spawned CLI execution is unsupported. |
| WSL | Not yet tested as a complete environment. |
| Yarn Classic 1.22 | Source and tarball installation tested on macOS. Modern Yarn does not provide `yarn global`. |
| Project-only runtime | Installed-runtime checks cover setup and local verification without a global Rivet command. |
| Registry package | Not published yet. Use [source installation](./installation.md). |

Node runs Rivet, not your application. Python/Django, Node.js and other projects use their own configured checks and dependency procedures. Automatic discovery does not recognize every framework or workspace layout; review setup and provide explicit commands when necessary.

## Coding harnesses

| Entry point | Tested scope |
| --- | --- |
| Claude Code CLI | Small spawned tasks on macOS, including Claude 2.1.280. |
| Codex CLI | Small spawned tasks on macOS with Codex 0.155.0-alpha.16. |
| Claude and Codex desktop | Host command support exists; complete desktop workflows have not been validated. |
| Other coding harnesses | Require local file/terminal tools, Rivet instructions and permission to operate on the project. End-to-end compatibility must be checked for the harness. |

CLI versions above record test evidence, not a version lock. Rivet probes required capabilities and stops when an installation cannot satisfy them. See [harness compatibility](./runtime-reference.md#harness-compatibility).

Local trials with both CLIs completed documentation tasks in a Node project with build, 40 tests and type-check, and a Docker Django project with a system check. The trials used prepared disposable environments; the Django plans were operator-supplied and the Claude runs used reviewed larger token allowances. They do not establish full application testing or unassisted first-user setup. Full active-host and desktop workflows still need testing.

## Integrations, models and delivery

Supported commands and their restrictions are described in [integrations](./integrations.md), [models](./models.md), [repository inspection](./repositories.md) and [delivery](./delivery.md).

Automated coverage exists for these interfaces. Live validation across provider accounts is incomplete. Test your configured connection in a suitable project before relying on it. In particular:

- Claude Worker budgets use native token counters, including cached context. Codex direct-result usage is model-reported and can understate consumption; do not rely on it as an enforced usage or billing limit. See [task budgets](./runtime-reference.md#native-usage-and-task-budgets).
- API/local text models provide advice, not autonomous implementation with coding tools. They do not enforce a monetary cap.
- GitHub and GitLab merges support specific repository policies. Unsupported or unreadable policies block merging.
- Bitbucket merging is manual.
- GitHub Actions deployment requires an explicitly configured workflow and separate approval.
- Shared cross-user memory is not implemented.

For installation problems or failed tasks, use [troubleshooting](./troubleshooting.md).
