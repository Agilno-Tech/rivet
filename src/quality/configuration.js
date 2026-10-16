import { createHash } from 'node:crypto';
import { immutableJson } from '../clients/contract.js';

// Bind reuse to the complete loaded project configuration, including provider
// and execution policy changes that are not part of an individual command.
export function configuredVerificationReuse(config) {
  if (!config.quality.verificationReuse) return {};
  return immutableJson({reuse:{
    policy:config.quality.verificationReuse,
    configDigest:createHash('sha256').update(JSON.stringify(config)).digest('hex'),
  }});
}
