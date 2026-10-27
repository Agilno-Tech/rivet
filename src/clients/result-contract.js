import {productQuestionSchema} from '../feature/product-question.js';
import { immutableJson } from './contract.js';

const AGENT_RESULT_CONTRACT = immutableJson({
  version: 1,
  kind: 'agilno.agent-result',
  framing: 'Emit exactly one JSON object matching this result schema on stdout. Emit no Markdown or commentary. For a successful result, output.evidence must contain exactly the evidence identifiers declared by the launch contract, with no invented or omitted identifiers. If a product decision blocks progress, return blocked with output.question and wait for the human answer. Its choice is a recommendation only; never decide it yourself.',
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'agilno.agent-result',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'status', 'output', 'usage'],
    properties: {
      version: { const: 1 },
      status: { enum: ['success', 'retry', 'failed', 'blocked', 'budget-exhausted'] },
      output: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'evidence'],
        properties: {
          question: productQuestionSchema,
          summary: { type: 'string', minLength: 1, maxLength: 16_384 },
          evidence: {
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
            },
          },
        },
      },
      usage: {
        type: 'object',
        additionalProperties: false,
        required: ['tokens', 'costUsd'],
        properties: {
          tokens: { type: 'integer', minimum: 0, maximum: 10_000_000 },
          costUsd: { type: 'number', minimum: 0, maximum: 100_000 },
        },
      },
    },
  },
});

export function agentResultContract(evidence = undefined, session = undefined) {
  if (session !== undefined) {
    const result = structuredClone(agentResultContract(evidence));
    result.schema.properties.status.enum.push('checkpoint');
    result.framing += ' For a managed session, checkpoint means a cooperative safe boundary: stop writing and summarize completed work, pending work, evidence and next action. Never report checkpoint for a provider failure.';
    return immutableJson(result);
  }
  if (evidence === undefined) return AGENT_RESULT_CONTRACT;
  if (!Array.isArray(evidence) || evidence.length > 64
    || evidence.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(item))) {
    throw new TypeError('Agent result evidence is invalid.');
  }
  return immutableJson({
    ...AGENT_RESULT_CONTRACT,
    schema: {
      ...AGENT_RESULT_CONTRACT.schema,
      properties: {
        ...AGENT_RESULT_CONTRACT.schema.properties,
        output: {
          ...AGENT_RESULT_CONTRACT.schema.properties.output,
          properties: {
            ...AGENT_RESULT_CONTRACT.schema.properties.output.properties,
            evidence: {
              ...AGENT_RESULT_CONTRACT.schema.properties.output.properties.evidence,
              minItems: evidence.length,
              maxItems: evidence.length,
              items: {
                ...AGENT_RESULT_CONTRACT.schema.properties.output.properties.evidence.items,
                enum: [...evidence],
              },
            },
          },
        },
      },
    },
  });
}
