# radio-driver-sdk

The generic radio control seam and simulated drivers live in `src`. Private protobuf definitions live in `proto`; generated TS descriptors live in `src/generated` and Python bindings in `generated/python`. Use the root generation/interoperability commands. Concrete VGC transport code lives in `services/drivers/vgc-benlink`, outside this package.

`GrpcRadioDriver` uses the generated descriptors with grpc-js for unary control, state and RX streams, and bounded TX frames. Unix sockets are local; remote connections require authenticated TLS. No write retries or automatic audio replay occur. The interoperability tests start an actual Python gRPC fixture when the pinned code-generation Python environment is installed. This fixture proves wire compatibility, not physical radio behavior.

See the [repository layout](../../docs/architecture/repository-layout.md) for dependency boundaries.
