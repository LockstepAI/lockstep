# Lockstep Dev CLI

Lockstep Dev is the open-source CLI for contracted, verifiable AI software work. It runs a local Codex or Claude session, applies policy and validator checks, and produces receipts that can be inspected later.

The CLI, local contract runner, spec format, and receipt verifier are the open-source surface. Hosted orchestration and API-backed receipt storage are optional and remain API-key gated to prevent abuse and support serious users. The TypeScript SDK is a thin API client for integrations.

Lockstep Inference is a separate commercial system for route-aware sparse-model serving. The inference stack, sparse routing primitive, resident expert scheduler, calibration paths, and model-specific serving recipes are not part of this open-source package.

## The Problem

AI coding agents can make useful changes quickly, but teams still need evidence. A terminal transcript is not enough for production review, compliance, or post-incident analysis. Teams need to know what prompt was used, which files were touched, which checks passed, which checks failed, and whether the final receipt was tampered with.

Lockstep wraps local execution with a contract. The contract defines the work, the boundaries, the required validation signals, and the receipt chain that proves the run state.

## What Lockstep Proves

Lockstep does not prove that a model is correct in an absolute sense. It proves that a specific run followed a declared workflow and produced a verifiable record.

It records:

- the spec file and spec hash
- each step prompt
- agent stdout and stderr hashes
- validator results
- step hash links
- final chain hash
- receipt metadata

The result is evidence that a reviewer, CI job, or auditor can inspect without trusting a rewritten summary.

## Quick Start

Install the CLI globally:

```bash
npm install -g @lockstepai/lockstep
lockstep --version
lockstep doctor
```

Save an API key only if you want hosted orchestration and API-backed receipt storage:

```bash
lockstep login ls_test_your_api_key
lockstep login ls_live_your_api_key
```

Configure local defaults:

```bash
lockstep setup
```

Create a spec inside the target repo:

```bash
cd /path/to/repo
lockstep templates
lockstep init blank
lockstep validate
lockstep review
lockstep run
```

## How It Works

`lockstep setup` detects local provider CLIs and saves machine defaults to `~/.locksteprc`. It asks for the default runner, default judge, delivery rigor, autonomy mode, model overrides, and Claude auth mode when Claude is involved.

`lockstep init` creates `.lockstep.yml` in the current repository. `lockstep run` reads that spec and executes each step. With a saved API key, runs can use the Lockstep API. Without a key, or with `--local`, the CLI uses the local executor.

Config precedence is:

1. command flags
2. `.lockstep.yml`
3. `~/.locksteprc`
4. built-in defaults

Runner and judge are separate. The runner performs the work. The judge reviews evidence and AI-judge criteria.

```bash
lockstep run --runner codex --judge codex
lockstep run --runner claude --judge codex
lockstep run --runner codex --judge claude
lockstep run --runner claude --judge claude --claude-auth-mode interactive
```

## The Spec File

A Lockstep spec is a YAML contract. It defines configuration, shared context, steps, commands, and validators.

```yaml
version: "1"

config:
  agent: "codex"
  judge_mode: "codex"
  execution_mode: "standard"
  max_retries: 3
  step_timeout: 300
  working_directory: "."

context: |
  Shared instructions for every step.

steps:
  - name: "Implement and verify"
    prompt: |
      Describe exactly what the agent should change.
    validate:
      - type: "file_exists"
        target: "package.json"
      - type: "command_passes"
        command: "npm test"
        timeout: 120
```

Run validation before executing:

```bash
lockstep validate
lockstep review --raw
```

## The AI Judge

The `ai_judge` validator asks the configured judge provider to evaluate output against explicit criteria. It is useful for qualitative review, but it must not be the only validator in a step. Add at least one structural or functional check such as `command_passes`, `test_passes`, `file_exists`, or `json_valid`.

Example:

```yaml
validate:
  - type: "command_passes"
    command: "npm test"
  - type: "ai_judge"
    criteria: "The implementation is minimal, safe, and matches the requested behavior."
    threshold: 0.8
    evaluation_targets:
      - "src"
```

## Verify Any Receipt

Receipts are JSON files with linked step hashes. Verify one with:

```bash
lockstep verify .lockstep/receipts/<receipt>.json
```

Verification checks the chain, step hashes, chain hash, completeness, and receipt shape. A missing original spec is reported as a warning; a broken chain or tampered step fails verification.

## Validator Reference

Built-in validator types:

- `file_exists`: requires `target`
- `file_not_exists`: requires `target`
- `file_contains`: requires `path` and `pattern`; optional `is_regex`
- `file_not_contains`: requires `path` and `pattern`; optional `is_regex`
- `command_passes`: requires `command`; optional `timeout`
- `command_output`: requires `command` and `pattern`; optional `is_regex` and `timeout`
- `api_responds`: requires `url` and `status`; optional `body_contains` and `timeout`
- `json_valid`: requires `path`; optional `schema`
- `type_check`: optional `command` and `timeout`
- `lint_passes`: optional `command` and `timeout`
- `test_passes`: requires `command`; optional `timeout`
- `ai_judge`: requires `criteria` and `threshold`; optional `evaluation_targets`, `rubric`, and `timeout`

## Templates

List available templates:

```bash
lockstep templates
```

Create a spec:

```bash
lockstep init blank
lockstep init nextjs-saas
lockstep init rest-api
lockstep init solana-program
```

Templates are starting points. Edit `.lockstep.yml` before production use so prompts, validators, and working directories match the real repo.

## CLI Reference

Public commands:

```bash
lockstep --version
lockstep doctor
lockstep templates
lockstep login <api-key>
lockstep setup
lockstep init [template]
lockstep validate [spec-file]
lockstep review [--raw] [spec-file]
lockstep policy init
lockstep contract init [--dry-run] [--output <path>]
lockstep run [spec-file]
lockstep run --runner <codex|claude> --judge <codex|claude>
lockstep run --runner-model <model> --judge-model <model>
lockstep run --execution-mode <standard|yolo>
lockstep run --claude-auth-mode <auto|interactive|api-key|auth-token|oauth-token|bedrock|vertex|foundry>
lockstep run --local --dry-run
lockstep run --local --phase <n>
lockstep run --local --from-phase <n>
lockstep run --local --output <path>
lockstep verify <receipt-file>
```

`doctor`, `templates`, `setup`, and `login` can run from any directory. `init`, `validate`, `review`, `policy init`, `contract init`, and `run` should run from the target repository root.

## Contributing

Run checks from this package directory:

```bash
npm test
bash test/run-all.sh
npm run build
```

Use `rg` when searching the codebase, keep public command output stable, and update docs when command behavior changes.

## License

MIT. See [LICENSE](LICENSE).
