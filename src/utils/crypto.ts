import stringify from 'json-stable-stringify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashObject(obj: unknown): string {
  const serialized = stringify(obj);
  if (serialized === undefined) {
    throw new Error('Cannot serialize value to stable JSON');
  }
  return sha256(serialized);
}

export function hashFileBytes(filePath: string): string {
  const buffer = readFileSync(filePath);
  return sha256(buffer);
}
