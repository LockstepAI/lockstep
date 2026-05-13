# Lockstep Dev Open-Source Release

This export contains the Lockstep Dev open-source surface: CLI, local runner,
templates, validators, SDK-adjacent client code where packaged with the CLI,
and receipt verification materials.

It intentionally excludes hosted API implementation, private research, customer
data, deployment files, and Lockstep Inference internals.

Before publishing:

```bash
npm install
npm run build
npm test
npm pack --dry-run
```

Review the dry-run file list.
