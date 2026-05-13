# Open-Source Boundary

Lockstep Dev is the open-source/free Instrument in the Lockstep AI stack.

This repository contains more than one surface. Do not publish the full working
tree as-is. The open-source boundary is intentionally narrower than the private
company workspace.

## Open-source surface

- `cli/`: Lockstep Dev CLI, local contract runner, templates, validators, and receipt verifier.
- `cli/sdk/` or `sdk/`: public TypeScript clients where they contain only API client logic and no private service credentials.
- Public examples and documentation that describe Dev contracts, validators, local execution, and receipt verification.

## Hosted/key-gated surface

- Hosted orchestration APIs.
- API-backed receipt storage.
- Abuse-prone hosted execution paths.
- Console account, team, key, and legacy billing controls.

These may be documented publicly, but access remains API-key gated.

## Private surface

- Lockstep Inference.
- Sparse routing primitives and calibration paths.
- Resident expert scheduling, route-aware cache policy, and model-specific serving recipes.
- Private evals, probes, competitive intelligence, customer notes, credentials, and deployment configuration.

Do not open-source private inference or research implementation files.

## Release rule

Before publishing an open-source repo or npm package, export only the intended
Dev surface and run:

```bash
npm run build
npm test
npm pack --dry-run
```

Review the packed file list before publishing.
