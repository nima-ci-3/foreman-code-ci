// ci-key-inputs: apps/worker scripts/worker-snapshot-policy.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { transformSync } from 'esbuild';
import { Packr, Unpackr, isNativeAccelerationEnabled } from 'msgpackr';

const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp');

test('Node 24 loads and executes sharp, msgpackr-extract and esbuild native dependencies', async () => {
  assert.equal(process.version, 'v24.22.1');
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).resize(1, 1).png().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 1);
  assert.equal(isNativeAccelerationEnabled, true);
  const value = [{ name: 'native record', count: 24 }, { name: 'second record', count: 1 }];
  assert.deepEqual(new Unpackr().unpack(new Packr().pack(value)), value);
  const output = transformSync('const count: number = 24; count', { loader: 'ts', target: 'node24' });
  assert.equal(Function(`${output.code}\nreturn count;`)(), 24);
});
