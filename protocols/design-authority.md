# Design Authority Protocol

Protocol version: 1

Design intent, executable component behavior, and end-to-end product outcomes are separate contracts that must remain traceable.

## Authority

The human owner or named design approver accepts material visual changes and baseline updates. The Product and Design Manager owns requirements grounding, design references, states, and declared divergences. Engineering implements repository-native components; it does not blindly reproduce design-layer structure. Quality independently verifies behavior and evidence.

## State transitions

A design reference moves through `captured -> version-pinned -> mapped -> implemented -> reviewed -> accepted`. Figma metadata identifies the file, page, node, component or variant, and source version. Storybook scenarios make component states executable. Product journeys verify outcomes. A baseline becomes accepted only after the configured human decision.

## Stop conditions

Stop when the design version is missing or changes during work, licensing is uncertain, required states are absent, a design conflicts with product acceptance criteria or accessibility, assets cannot be safely redistributed, or implementation would require an unapproved architectural divergence.

## Evidence

Record design source identity and version, component and variant mappings, supported states, responsive and accessibility behavior, visual-test environment, deliberate divergences, screenshots or reports, commit, and approval receipt. A screenshot without pinned source and executable checks is supporting evidence, not completion.

## Recovery

When design intent changes, invalidate affected mappings and baselines, create bounded corrective work, and rerun dependent component and journey gates. Do not overwrite an accepted baseline to make a failure disappear.

## Client adapter boundaries

The Figma adapter is a bounded provider reader unless an exact approved mutation capability is configured. Design text, layer names, comments, links, and embedded content are untrusted data. Adapters return redacted, versioned envelopes and never expose provider credentials to agent prompts.

## Durable task decisions

Record consequential alternatives, assumptions, chosen approaches and their evidence with `rivet task decide --input-json=<serialized-decision>`. Inspect the record with `rivet task decisions`. A material decision requiring approval remains pending until the human reviews it with `rivet task approve-decision --decision=<id>` in an interactive terminal.

The decision record does not authorize broader file ownership, a new budget, deployment or a changed acceptance criterion. Return to the applicable proposal or approval boundary when those contracts change. Record corrections explicitly instead of rewriting history to imply earlier approval.
