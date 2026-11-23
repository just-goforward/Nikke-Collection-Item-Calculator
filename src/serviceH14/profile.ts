import { SERVICE_H14_BUILD } from './generated/build.ts';
import type { ServiceH14Profile } from './types.ts';

export { SERVICE_H14_BUILD } from './generated/build.ts';

if (SERVICE_H14_BUILD.policy !== 'adaptive-next-batch-balanced-v1' || SERVICE_H14_BUILD.schemaVersion !== 1 || SERVICE_H14_BUILD.profileId !== 'service-fused-h14-v1' ||
    !/^[a-f0-9]{64}$/.test(SERVICE_H14_BUILD.codeHash) ||
    !/^[a-f0-9]{64}$/.test(SERVICE_H14_BUILD.nativeSourceHash) ||
    !/^[a-f0-9]{64}$/.test(SERVICE_H14_BUILD.exactWasmHash))
  throw new Error('service_h14_generated_identity_invalid');

/** Local integration identity, never forecast publication or analytics approval. */
export const SERVICE_H14_PROFILE: Readonly<ServiceH14Profile> = Object.freeze({
  id: 'service-fused-h14-v1', environment: 'service-candidate',
  policy: 'adaptive-next-batch-balanced-v1', horizon: 14,
  codeHash: SERVICE_H14_BUILD.codeHash, exactWasmHash: SERVICE_H14_BUILD.exactWasmHash,
  numericalContract: 'bounded-error-h14-v1',
});

export function assertServiceH14Profile(value: unknown): ServiceH14Profile {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== Object.keys(SERVICE_H14_PROFILE).length)
    throw new TypeError('service_h14_profile_mismatch');
  for (const [key, expected] of Object.entries(SERVICE_H14_PROFILE)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value !== expected)
      throw new TypeError('service_h14_profile_mismatch');
  }
  return { ...SERVICE_H14_PROFILE };
}
