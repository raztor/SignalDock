import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  IdSchema,
  SignalDockError,
  type ArtifactMetadata,
  type ArtifactStoragePort,
} from '@signaldock/contracts';

export class FileArtifactStorage implements ArtifactStoragePort {
  private readonly root: string;
  constructor(
    directory: string,
    private readonly maxArtifactBytes = 128 * 1024 * 1024,
  ) {
    this.root = resolve(directory);
  }
  private async directory(instanceId: string): Promise<string> {
    IdSchema.parse(instanceId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const directory = join(root, instanceId);
    await mkdir(directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    if (
      (await lstat(directory)).isSymbolicLink() ||
      !(await realpath(directory)).startsWith(root + sep)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Artifact directory is outside private storage.',
      );
    return directory;
  }
  async put(input: {
    instanceId: string;
    artifactId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<ArtifactMetadata> {
    IdSchema.parse(input.artifactId);
    if (
      !input.bytes.byteLength ||
      input.bytes.byteLength > this.maxArtifactBytes ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.contentType)
    )
      throw new SignalDockError(
        'INVALID_ARGUMENT',
        'Invalid artifact type or size.',
      );
    const directory = await this.directory(input.instanceId);
    const metadata: ArtifactMetadata = {
      instanceId: input.instanceId,
      artifactId: input.artifactId,
      sizeBytes: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      contentType: input.contentType,
    };
    const body = join(directory, `${input.artifactId}.bin`);
    const manifest = join(directory, `${input.artifactId}.json`);
    const temporary = join(
      directory,
      `${input.artifactId}.${randomUUID()}.tmp`,
    );
    const file = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(input.bytes);
      await file.sync();
      await file.close();
      try {
        await link(temporary, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await open(
          body,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const hash = createHash('sha256')
            .update(await existing.readFile())
            .digest('hex');
          if (hash !== metadata.sha256)
            throw new SignalDockError(
              'OPERATION_CONFLICT',
              'Artifact ID already has different content.',
            );
        } finally {
          await existing.close();
        }
      }
      const contents = Buffer.from(JSON.stringify(metadata) + '\n');
      const manifestTemporary = temporary + '.json';
      const metadataFile = await open(
        manifestTemporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await metadataFile.writeFile(contents);
        await metadataFile.sync();
        await metadataFile.close();
        try {
          await link(manifestTemporary, manifest);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if ((await readFile(manifest, 'utf8')) !== contents.toString())
            throw new SignalDockError(
              'OPERATION_CONFLICT',
              'Artifact metadata differs.',
            );
        }
      } finally {
        await metadataFile.close().catch(() => undefined);
        await unlink(manifestTemporary).catch(() => undefined);
      }
      return metadata;
    } finally {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  async read(
    instanceId: string,
    artifactId: string,
    range?: { start: number; end?: number },
  ) {
    IdSchema.parse(artifactId);
    const directory = await this.directory(instanceId);
    try {
      const manifest = await open(
        join(directory, `${artifactId}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let metadata: ArtifactMetadata;
      try {
        metadata = JSON.parse(
          await manifest.readFile('utf8'),
        ) as ArtifactMetadata;
      } finally {
        await manifest.close();
      }
      if (
        metadata.instanceId !== instanceId ||
        metadata.artifactId !== artifactId ||
        !Number.isSafeInteger(metadata.sizeBytes) ||
        metadata.sizeBytes < 0 ||
        metadata.sizeBytes > this.maxArtifactBytes
      )
        throw new Error('Invalid artifact manifest.');
      const start = range?.start ?? 0;
      const end = range?.end ?? metadata.sizeBytes - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= metadata.sizeBytes
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Requested artifact range is not satisfiable.',
        );
      const file = await open(
        join(directory, `${artifactId}.bin`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (stat.size !== metadata.sizeBytes)
          throw new Error('Artifact size does not match its manifest.');
        const bytes = Buffer.alloc(end - start + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const read = await file.read(
            bytes,
            offset,
            bytes.byteLength - offset,
            start + offset,
          );
          if (!read.bytesRead) throw new Error('Artifact was truncated.');
          offset += read.bytesRead;
        }
        if (
          start === 0 &&
          end === metadata.sizeBytes - 1 &&
          createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
        )
          throw new Error('Artifact checksum does not match its manifest.');
        return { metadata, bytes, totalBytes: metadata.sizeBytes, start, end };
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new SignalDockError('NOT_FOUND', 'Artifact is unavailable.');
      throw error;
    }
  }
  async delete(instanceId: string, artifactId: string): Promise<void> {
    IdSchema.parse(artifactId);
    const directory = await this.directory(instanceId);
    for (const suffix of ['json', 'bin']) {
      await unlink(join(directory, `${artifactId}.${suffix}`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    }
  }
}
