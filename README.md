# Lockstep CLI

Guided terminal CLI for Lockstep Dev.

It helps you set up local provider defaults, draft repo policy, draft a contract from plain English, review the workflow, and run it locally with receipts.

Lockstep runs from your machine. Install `codex` and or `claude` first, sign in there, then use Lockstep to govern and verify the workflow.

## Install

```bash
npm install -g @lockstepai/lockstep
```

## Quick start

```bash
lockstep setup
lockstep policy init
lockstep contract init
lockstep review
lockstep run
```

## What setup does

`lockstep setup` detects local providers, checks available Claude auth modes, and saves your default runner, judge, autonomy, workflow preset, and rigor profile.

Today the CLI supports local `codex`, local `claude`, or mixed runner and judge combinations.

## Typical flow

1. Run `lockstep setup`
2. Run `lockstep policy init` to draft repo guardrails from plain English
3. Run `lockstep contract init` to draft a strict contract from plain English
4. Run `lockstep review` to inspect defaults, policy, and contract together
5. Run `lockstep run` to execute and generate a receipt

## Notes

Node 18 or newer is required.

This package is the terminal experience. It is not the TypeScript SDK and it does not host repo execution in the cloud.

If you want the API client instead, use `@lockstepai/sdk`.
