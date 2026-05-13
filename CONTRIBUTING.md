# Contributing

Lockstep Dev is the open-source/free Instrument for contracted, verifiable AI
software work.

## Development

```bash
npm install
npm run build
npm test
```

Use `lockstep run --local` for local execution flows and keep API-backed
behavior optional unless a change specifically targets hosted orchestration.

## Pull requests

- Keep public CLI behavior stable.
- Add or update tests for validator, parser, receipt, or runner behavior.
- Update `README.md` and templates when command behavior changes.
- Do not add Lockstep Inference internals, private deployment details, secrets,
  customer data, or proprietary sparse-routing logic to this package.

## Public boundary

The CLI, local runner, spec format, templates, validators, and receipt verifier
are the open-source surface. Hosted APIs are key-gated. Lockstep Inference is
private commercial infrastructure.
