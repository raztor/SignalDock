# Private artifact storage

`FileArtifactStorage` implements the shared artifact port with instance/UUID-bound paths, private file permissions, atomic immutable writes, checksums, range reads, and idempotent deletion. Default maximum artifact size is 128 MiB and may be configured when constructing the store.

Paths are never accepted from frontend data. Metadata and payload are stored below a private configured root. Full reads verify SHA-256; range reads validate size and bounds. Instance directory symlinks and payload symlinks are rejected. Domain services must authorize every access and enforce database lifecycle/tombstones before calling this private port.

There is no public static file mount. An S3 implementation can implement the same port in a future package without changing communication IDs.
