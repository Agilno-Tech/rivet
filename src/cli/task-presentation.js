const STATES = Object.freeze({
  proposed: 'Plan saved, waiting for your approval',
  approved: 'Plan approved, ready to start',
  running: 'Work is in progress',
  blocked: 'Work paused and needs attention',
  'awaiting-final-approval': 'Changes passed checks and are ready for your review',
  completed: 'Completed',
  cancelled: 'Cancelled',
});
export function taskState(value) { return STATES[value] ?? 'Inspect task status for the next step'; }
export function failureGuidance(code, command) {
  const task = ['run','task','feature','work'].includes(command);
  switch(code) {
    case 'INVALID_INPUT': return 'Check rivet --help for everyday commands, or rivet --help --advanced for harness commands.';
    case 'MISSING_CONFIGURATION': return 'Run rivet doctor from your project. If it is not configured yet, preview rivet setup first.';
    case 'BLOCKED_AUTHORITY': return 'Review the denied operation in your coding harness and request permission for that exact operation.';
    case 'FAILED_GATE': return task ? 'Run rivet task status to inspect the failed checks. Fix the reported cause before continuing with rivet task resume.' : 'Run rivet doctor and resolve the reported failing check before retrying.';
    case 'PROVIDER_UNAVAILABLE': return 'Check the reported harness or provider installation, authentication and permissions, then retry.';
    case 'REPOSITORY_CONFLICT': return task ? 'Inspect rivet task status and your checkout. Preserve existing edits and follow the reported recovery step before retrying.' : 'Inspect the reported repository or saved-state conflict. Preserve existing edits before retrying.';
    default: return 'Review the diagnostic report and attach it with reproduction steps at https://github.com/FraneAgilno/rivet/issues/new.';
  }
}
