# Repository scripts

- `codegen/`: shared contract and driver-binding generation, plus the isolated Python generator requirements.
- `checks/`: cross-language driver-binding verification.
- `development/`: reserved local development helpers.
- `maintenance/`: reserved explicit maintenance/migration helpers.

Run the public commands in the root `package.json` from the repository root. Generic scripts must not implicitly contact radio hardware. Manufacturer-specific test scripts live with their driver module, not here.
