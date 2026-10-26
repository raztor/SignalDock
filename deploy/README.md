# Deployment

`api.Dockerfile` builds the discovery API image. `compose.yaml` runs that initial slice with a persistent identity volume. The Linux CI job builds and smoke-tests the image. This is not yet the complete product stack.

Add versioned deployment files for database, workers, media, runtime/drivers, and the optional relay as those components are implemented. Native Mac hardware validation stays outside Docker. Production Linux hardware/permissions and ARM64 acceptance remain separate gates. See [infrastructure specification](../docs/specifications/13-infrastructure.md).
