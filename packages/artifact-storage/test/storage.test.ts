import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStorage } from '../src/index.js';

const roots: string[] = [];
async function storage() {
  const directory = await mkdtemp(join(tmpdir(), 'sd-artifact-'));
  roots.push(directory);
  return { directory, store: new FileArtifactStorage(directory, 1024) };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('private artifact storage', () => {
  it('keeps immutable checksummed files private and supports exact byte ranges', async () => {
    const { store, directory } = await storage();
    const instanceId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    const input = {
      instanceId,
      artifactId,
      bytes: new Uint8Array([0, 1, 2, 3, 255]),
      contentType: 'audio/wav',
    };
    const metadata = await store.put(input);
    expect(await store.put(input)).toEqual(metadata);
    expect(
      Array.from(
        (await store.read(instanceId, artifactId, { start: 1, end: 3 })).bytes,
      ),
    ).toEqual([1, 2, 3]);
    expect(
      (await stat(join(directory, instanceId, `${artifactId}.bin`))).mode &
        0o777,
    ).toBe(0o600);
    await expect(
      store.put({ ...input, bytes: new Uint8Array([9]) }),
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    await expect(
      store.read(crypto.randomUUID(), artifactId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      store.read(instanceId, artifactId, { start: 0, end: 5 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('rejects traversal, oversized writes and symlinked instance directories', async () => {
    const { store, directory } = await storage();
    const artifactId = crypto.randomUUID();
    await expect(
      store.put({
        instanceId: '../private',
        artifactId,
        bytes: new Uint8Array([1]),
        contentType: 'audio/wav',
      }),
    ).rejects.toThrow();
    await expect(
      store.put({
        instanceId: crypto.randomUUID(),
        artifactId,
        bytes: new Uint8Array(1025),
        contentType: 'audio/wav',
      }),
    ).rejects.toThrow();
    const instanceId = crypto.randomUUID();
    const outside = await mkdtemp(join(tmpdir(), 'sd-outside-'));
    roots.push(outside);
    await symlink(outside, join(directory, instanceId));
    await expect(
      store.put({
        instanceId,
        artifactId,
        bytes: new Uint8Array([1]),
        contentType: 'audio/wav',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('detects corruption and makes deleted objects inaccessible', async () => {
    const { store, directory } = await storage();
    const instanceId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    await store.put({
      instanceId,
      artifactId,
      bytes: new Uint8Array([1, 2]),
      contentType: 'audio/wav',
    });
    const body = join(directory, instanceId, `${artifactId}.bin`);
    await writeFile(body, new Uint8Array([9, 8]));
    await expect(store.read(instanceId, artifactId)).rejects.toThrow(
      'checksum',
    );
    await store.delete(instanceId, artifactId);
    await store.delete(instanceId, artifactId);
    await expect(store.read(instanceId, artifactId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(readFile(body)).rejects.toThrow();
  });
});
