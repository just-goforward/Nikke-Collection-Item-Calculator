import { assertWasmAssetBytes, fetchVerifiedWasmAsset } from '../../shared/wasmAssetBytes.ts';
import { reserveTargetPayload, type WorkBudget } from '../certified/budget.ts';
import { assertFusedModule } from './fusedModule.ts';
import native from './generated/native.json' with { type: 'json' };
import { SERVICE_H14_BUILD } from './generated/build.ts';

export const SERVICE_H14_NATIVE_PIN = Object.freeze({ ...native.wasm });
export const assertServiceH14Module = assertFusedModule;

function assertNativePin(): void {
  const pin = SERVICE_H14_NATIVE_PIN;
  if (native.schemaVersion !== 1 || native.profileId !== 'service-fused-h14-v1' ||
      native.abi.base !== 1 || native.abi.fused !== 3 || native.abi.joint !== 2 || native.abi.currentBatch !== 2 ||
      SERVICE_H14_BUILD.profileId !== native.profileId || SERVICE_H14_BUILD.schemaVersion !== 1 ||
      native.sourceHash !== SERVICE_H14_BUILD.nativeSourceHash ||
      pin.sha256 !== SERVICE_H14_BUILD.exactWasmHash || !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      pin.assetPath !== `/wasm/service-fused-h14-${pin.sha256}.wasm` ||
      !Number.isSafeInteger(pin.byteLength) || pin.byteLength <= 0 || pin.byteLength > 32 * 1024 * 1024)
    throw new Error('service_h14_wasm_pin_mismatch');
}

/** No old/public alias fallback. The same request budget owns fetch, hash and compile. */
export async function loadServiceH14Module(readBytes?: () => Promise<Uint8Array>, budget?: WorkBudget): Promise<WebAssembly.Module> {
  assertNativePin();
  budget?.checkNumerical();
  const pin = SERVICE_H14_NATIVE_PIN, owned = 65536 + pin.byteLength * 4;
  if (budget) reserveTargetPayload(budget, owned);
  try {
    const asset = { sha256: pin.sha256, bytes: pin.byteLength };
    const bytes = readBytes ? await assertWasmAssetBytes(await readBytes(), asset, 'service_h14_wasm') :
      await fetchVerifiedWasmAsset((import.meta.env?.BASE_URL ?? '/') + pin.assetPath.slice(1), asset, 'service_h14_wasm', { cache: 'no-cache', credentials: 'omit', redirect: 'error' });
    budget?.checkNumerical();
    const module = await WebAssembly.compile(new Uint8Array(bytes));
    assertServiceH14Module(module);
    budget?.checkNumerical();
    return module;
  } finally { budget?.release(owned); }
}
