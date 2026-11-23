/** Shared build/runtime descriptor contract; no generated identity import. */
export function assertFusedModule(module: WebAssembly.Module): void {
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 1 || imports[0]?.module !== 'certified' || imports[0]?.name !== 'now_ms' || imports[0]?.kind !== 'function')
    throw new Error('fused_wasm_import_contract');
  const exports = new Map(WebAssembly.Module.exports(module).map(item => [item.name, item.kind]));
  if (exports.get('memory') !== 'memory') throw new Error('fused_wasm_memory');
  for (const name of ['certified_current_batch_version','certified_current_batch_rows','certified_abi_version', 'certified_input', 'certified_call', 'certified_output_ptr', 'certified_output_len',
    'certified_heap_live', 'certified_heap_peak', 'certified_heap_limit', 'certified_allocation_denied', 'certified_release', 'certified_reset_heap_peak',
    ...['version', 'begin', 'next', 'ack', 'clear'].map(suffix => `certified_joint_${suffix}`),
    ...['version', 'init', 'batch', 'threshold', 'clear', 'stat'].map(suffix => `certified_fused_${suffix}`)])
    if (exports.get(name) !== 'function') throw new Error(`fused_wasm_missing_export:${name}`);
  for (const name of exports.keys())
    if (/^certified_(direct_|date_factors_|primary_)/.test(name)) throw new Error('fused_wasm_legacy_abi');
}
