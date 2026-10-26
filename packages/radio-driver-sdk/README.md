# radio-driver-sdk

The generic radio control seam and simulated drivers live in `src`. Private protobuf definitions live in `proto`; generated TS descriptors live in `src/generated` and Python bindings in `generated/python`. Use the root generation/interoperability commands. Concrete VGC transport code lives in `services/drivers/vgc-benlink`, outside this package.

See the [repository layout](../../docs/architecture/repository-layout.md) for dependency boundaries.
