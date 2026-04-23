# Lockstep SDK

TypeScript client for Lockstep Dev.

It connects your app, service, or local runner to the Lockstep API so you can start runs, poll for prompts, submit step results, and verify receipts.

It does not run Codex or Claude, manage repositories, or execute work on its own.

## Install

```bash
npm install @lockstepai/sdk
```

## Quickstart

```ts
import { Lockstep } from '@lockstepai/sdk';

const lockstep = new Lockstep({
  apiKey: process.env.LOCKSTEP_API_KEY!,
});

const spec = `
version: "1"
steps:
  - name: Verify workspace
    prompt: Create docs/summary.md.
    validate:
      - type: file_exists
        target: docs/summary.md
`;

const run = await lockstep.createRun(spec);
const next = await lockstep.poll(run.runId);

if (next.status === 'prompt_ready') {
  await lockstep.submitResult(run.runId, {
    stepIndex: next.stepIndex,
    attempt: next.attempt,
    validationResults: [
      {
        type: 'file_exists',
        target: 'docs/summary.md',
        passed: true,
      },
    ],
    agentStdoutHash: 'stdout_hash',
    agentStderrHash: 'stderr_hash',
  });
}

const receipt = await lockstep.verifyReceipt(run.runId);
console.log(receipt.verified);
```

## Core methods

```ts
createRun(spec)
getRun(runId)
poll(runId)
submitResult(runId, result)
cancelRun(runId)
waitForCompletion(runId)
verifyReceipt(runId)
```

## Notes

Use a Lockstep API key or JWT.

Default API URL: `https://api.lockstepai.dev`

The SDK is a thin client. Enforcement, receipts, billing, and trust decisions live on the Lockstep API.
