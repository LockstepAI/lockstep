# Security Policy

## Supported surface

Security reports for the open-source Lockstep Dev CLI, local runner, templates,
validators, SDK client behavior, and receipt verifier are in scope.

Lockstep Inference internals, private deployment configuration, customer data,
and hosted service credentials are not part of the open-source package.

## Reporting

Report vulnerabilities privately to security@lockstepai.dev.

Please include:

- Affected package and version.
- Reproduction steps.
- Expected and actual behavior.
- Any impact on local execution, receipt integrity, key handling, or hosted API
  calls.

Do not publish exploit details until we have acknowledged and remediated the
issue.

## Secret handling

Never commit API keys, `.env` files, receipt signing secrets, customer prompts,
or hosted deployment credentials. Use test keys only in examples.
