function visible(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, character =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

export function confirmIsolatedDependencyInstall(dependencies, signal) {
  return plan => {
    if (plan.kind === 'portable') {
      dependencies.output.log(`Prepare project dependencies in ${visible(plan.worktreePath)}?`);
      dependencies.output.log(`Approved checkout: ${visible(plan.expectedBranch)} at ${visible(plan.expectedCommit)}`);
      for (const input of plan.inputs) dependencies.output.log(`Input: ${visible(input.path)} sha256=${input.sha256}`);
      for (const step of plan.steps) dependencies.output.log(`Command in ${visible(step.cwd)}: ${JSON.stringify(step.argv)}`);
      dependencies.output.log('These exact project commands may execute dependency code. Approval is not a filesystem sandbox.');
      return dependencies.confirmDependencyInstall(plan, { signal });
    }
    dependencies.output.log(`Install locked dependencies in ${visible(plan.worktreePath)}?`);
    dependencies.output.log(`Command: ${visible(plan.executable)} ${plan.args.map(visible).join(' ')}`);
    dependencies.output.log('Package installation may run scripts supplied by the project or its dependencies.');
    return dependencies.confirmDependencyInstall(plan, { signal });
  };
}
