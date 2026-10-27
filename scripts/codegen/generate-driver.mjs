import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const python = resolve('.venv-codegen/bin/python');
const sdk = 'packages/radio-driver-sdk';
const tsOutput = `${sdk}/src/generated`;
const pythonOutput = `${sdk}/generated/python`;
mkdirSync(tsOutput, { recursive: true });
mkdirSync(pythonOutput, { recursive: true });
const includes = execFileSync(
  python,
  [
    '-c',
    'import pathlib, grpc_tools; print(pathlib.Path(grpc_tools.__file__).parent / "_proto")',
  ],
  { encoding: 'utf8' },
).trim();
execFileSync(
  python,
  [
    '-m',
    'grpc_tools.protoc',
    `-I${sdk}/proto`,
    `-I${includes}`,
    `--plugin=protoc-gen-es=${resolve('node_modules/.bin/protoc-gen-es')}`,
    `--es_out=${tsOutput}`,
    '--es_opt=target=ts',
    `--python_out=${pythonOutput}`,
    `--grpc_python_out=${pythonOutput}`,
    `${sdk}/proto/signaldock/driver/v1/driver.proto`,
  ],
  { stdio: 'inherit' },
);

for (const directory of [tsOutput, pythonOutput]) {
  for (const entry of readdirSync(directory, { recursive: true })) {
    if (!/\.(ts|py)$/.test(entry)) continue;
    const path = resolve(directory, entry);
    writeFileSync(path, readFileSync(path, 'utf8').trimEnd() + '\n');
  }
}
