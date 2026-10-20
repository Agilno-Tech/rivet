# Models and reasoning

Choose models during setup, then let Rivet reuse the saved choices when you run tasks. Task execution uses an installed, authenticated **Claude Code or Codex CLI**.

## Accept or customize the recommended setup

```sh
rivet setup --write
```

In the model step, accept the recommended setup, customize it, or skip it for later. Rivet shows the model, reasoning level and role before asking you to save.

To revisit these choices in a configured project:

```sh
rivet models configure
```

Customize individual models, reasoning levels or worker concurrency. Fresh setup recommends two workers; existing custom capacities are preserved unless you change them. Review and commit the saved configuration before creating new tasks. Existing approved tasks keep their approved settings.

The recommendations use the models Rivet can detect:

| Work | Codex family | Claude alias |
| --- | --- | --- |
| Coordination and technical decisions | Astra | `opus` |
| Independent review | Astra | `opus` |
| Substantial implementation and complex debugging | Sol | `sonnet` |
| Bounded fixes, focused tests and investigations | Luna | `haiku` |

Rivet proposes high reasoning where supported. It shows exact model IDs and explains alternatives when a preferred model is missing. Accepting detected recommendations makes no model call. Detection is local evidence, not proof of current account access.

## Describe your preferences {#model-and-reasoning-policy}

You can describe the mapping instead of editing configuration:

```sh
rivet models configure "Use high reasoning. Use Astra or Opus for coordination and independent review, Sol for implementation, and Luna for bounded fixes."
```

Rivet uses an installed Claude Code or Codex CLI to translate your description. This makes a model call through that CLI's existing account. If both are available, choose which one to use for translation.

1. Describe the policy.
2. Resolve alternatives or model names that need clarification.
3. Review the four roles, exact models and reasoning levels.
4. Approve to save, or decline to leave configuration unchanged.

Rivet does not silently substitute models or switch accounts. If a saved choice is unavailable, it stops and asks you to resolve it. Use `rivet models configure` to change saved routing rather than overriding it when starting a task.

**A review route chooses the model; it does not start reviews automatically.** See the [orchestration flow and current scope](./orchestration.md#scope).

## See what Rivet detects

```sh
rivet models list
```

Rivet detects local evidence for Claude Code, Codex, Anthropic, OpenAI, Gemini, Ollama and OpenAI-compatible endpoints. API and local-model adapters support separate advisory text requests; they do not execute task workers. Provider detection does not authenticate an account or call its endpoint.

## Advanced configuration

- [Codex configuration, cached models and reasoning recommendations](./runtime-reference.md#model-detection-and-routing-details).
- [Provider detection, manual profiles and advisory text delegation](./runtime-reference.md#model-providers-and-delegation).
- [Worker harness overrides](./runtime-reference.md#choose-a-harness-for-workflow-workers).
- [Execution policy schema](./runtime-reference.md#execution-policy-contract) and [manual YAML example](./runtime-reference.md#managed-execution-configuration).
