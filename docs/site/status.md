# Capabilities and limitations

Rivet is available on [npm](https://www.npmjs.com/package/@agilno-tech/rivet) as `@agilno-tech/rivet`. Follow the [installation guide](./installation.md) to install the current release. The default `latest` tag still contains alpha software.

## Available now

| Capability | What you can do |
| --- | --- |
| Project setup | Preview and save checks, dependency commands and Claude/Codex skills. Use projects in any language with explicit commands when automatic detection is insufficient. |
| Terminal tasks | Run a task with an installed Claude or Codex CLI, review its plan, inspect status and resume eligible tasks. |
| Coding-harness tasks | Let your current coding agent follow Rivet's skill and execute approved actions. |
| Isolated work and verification | Keep task changes in Git worktrees and record checks against the accepted commit. |
| Project procedures | Create, publish, discover, update and retire versioned protocols. |
| Context integrations | Configure Jira/Linear requests and linked Figma/Confluence context through supported transports. |
| Models | Select Claude/Codex workers or explicitly delegate advisory text to supported API/local models. |
| Repository delivery | Inspect GitHub, GitLab and Bitbucket; publish verified branches and create or update reviews. GitHub/GitLab merges support the documented policy subsets. |
| Deployment and trackers | Separately approve a configured GitHub Actions deployment or Jira/Linear delivery updates. |
| Troubleshooting | Inspect task/checkouts, collect a redacted support bundle and recover eligible abandoned host locks. |

## Before you rely on a feature

- CLI workflows have completed small real tasks on macOS with both Claude and Codex. Full desktop workflows and unassisted onboarding still need testing.
- CI covers Linux/macOS with Node 22 and 24. Native Windows execution is unsupported.
- Context integrations, API/local model delegation and remote delivery have automated coverage; live validation across their supported providers is incomplete.
- GitHub and GitLab merge support is limited to the policies documented in [delivery](./delivery.md). Merge Bitbucket reviews manually.
- Shared cross-user memory is not available. Project protocols are available.

See [compatibility](./compatibility.md) for tested scope and [troubleshooting](./troubleshooting.md) for remedies.
