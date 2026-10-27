# Radio drivers

Each manufacturer/protocol integration gets its own folder and README, with capabilities, dependencies, transport requirements, validation evidence, and upstream attribution. The first module is [vgc-benlink](vgc-benlink/README.md).

Drivers implement the [generic radio SDK](../../packages/radio-driver-sdk/README.md). A Python/native driver is not automatically an npm workspace. Add language-specific manifests and deployment files only when that implementation exists.
