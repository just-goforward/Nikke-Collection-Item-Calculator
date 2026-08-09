export const COMPACT_FRONTIER_WGSL = /* wgsl */ `
struct Params {
  input_count: u32,
  hash_mask: u32,
  purple_dim: u32,
  yellow_dim: u32,
  stock_id_size: u32,
  state_buckets: u32,
  reserved_0: u32,
  reserved_1: u32,
}

@group(0) @binding(0) var<storage, read> input_keys: array<u32>;
@group(0) @binding(1) var<storage, read> transitions: array<u32>;
@group(0) @binding(2) var<storage, read_write> hash_table: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> params: Params;

fn hash_key(value: u32) -> u32 {
  var hash = value;
  hash = hash ^ (hash >> 16u);
  hash = hash * 0x85ebca6bu;
  hash = hash ^ (hash >> 13u);
  hash = hash * 0xc2b2ae35u;
  return hash ^ (hash >> 16u);
}

fn insert_key(key: u32) {
  let stored = key + 1u;
  var slot = hash_key(key) & params.hash_mask;
  var probes = 0u;
  loop {
    let exchanged = atomicCompareExchangeWeak(&hash_table[slot], 0u, stored);
    if (exchanged.exchanged) {
      atomicAdd(&counters[0], 1u);
      return;
    }
    if (exchanged.old_value == stored) {
      return;
    }
    probes = probes + 1u;
    if (probes > params.hash_mask) {
      atomicAdd(&counters[1], 1u);
      return;
    }
    slot = (slot + 1u) & params.hash_mask;
  }
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let candidate_index = gid.x;
  let candidate_count = params.input_count * 3u;
  if (candidate_index >= candidate_count) {
    return;
  }
  let input_index = candidate_index / 3u;
  let action = candidate_index % 3u;
  let key = input_keys[input_index];
  let sid = key / params.stock_id_size;
  if (sid >= params.state_buckets) {
    atomicAdd(&counters[1], 1u);
    return;
  }
  let level = (sid / 30u) % 16u;
  let grade = sid / 480u;
  if ((grade == 1u && level >= 15u) || (grade == 0u && level >= 15u)) {
    return;
  }

  let stock_id = key - sid * params.stock_id_size;
  var blue = stock_id / (params.purple_dim * params.yellow_dim);
  let stock_remainder = stock_id - blue * params.purple_dim * params.yellow_dim;
  var purple = stock_remainder / params.yellow_dim;
  var yellow = stock_remainder - purple * params.yellow_dim;
  if ((action == 0u && blue == 0u) || (action == 1u && purple == 0u) || (action == 2u && yellow == 0u)) {
    return;
  }
  if (action == 0u) { blue = blue - 1u; }
  if (action == 1u) { purple = purple - 1u; }
  if (action == 2u) { yellow = yellow - 1u; }
  let next_stock_id = (blue * params.purple_dim + purple) * params.yellow_dim + yellow;
  let transition_offset = (sid * 3u + action) * 2u;
  let success_sid = transitions[transition_offset];
  let failure_sid = transitions[transition_offset + 1u];
  insert_key(success_sid * params.stock_id_size + next_stock_id);
  insert_key(failure_sid * params.stock_id_size + next_stock_id);
}
`;

export type WebGpuFrontierMetadata = {
  adapter: string;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maximumInputCount: number;
  hashCapacity: number;
  hashBytes: number;
};

export type WebGpuFrontierSession = {
  metadata: WebGpuFrontierMetadata;
  expand(inputKeys: readonly number[]): Promise<number[]>;
  close(): void;
};

type BufferLike = {
  destroy(): void;
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
};

type DeviceLike = {
  createBindGroup(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): BufferLike;
  createCommandEncoder(): {
    beginComputePass(): {
      dispatchWorkgroups(count: number): void;
      end(): void;
      setBindGroup(index: number, group: unknown): void;
      setPipeline(pipeline: unknown): void;
    };
    copyBufferToBuffer(
      source: BufferLike,
      sourceOffset: number,
      target: BufferLike,
      targetOffset: number,
      size: number,
    ): void;
    finish(): unknown;
  };
  createComputePipelineAsync(
    descriptor: unknown,
  ): Promise<{ getBindGroupLayout(index: number): unknown }>;
  createShaderModule(descriptor: { code: string }): unknown;
  destroy(): void;
  limits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    maxStorageBuffersPerShaderStage: number;
  };
  lost: Promise<{ message: string; reason: string }>;
  queue: {
    submit(commands: unknown[]): void;
    writeBuffer(buffer: BufferLike, offset: number, data: ArrayBufferView): void;
  };
};

type AdapterLike = {
  info?: { architecture?: string; device?: string; description?: string; vendor?: string };
  limits: DeviceLike["limits"];
  requestDevice(): Promise<DeviceLike>;
};

type NavigatorGpu = {
  requestAdapter(options?: {
    powerPreference?: "high-performance" | "low-power";
  }): Promise<AdapterLike | null>;
};

type WebGpuGlobals = {
  GPUBufferUsage: Record<"COPY_DST" | "COPY_SRC" | "MAP_READ" | "STORAGE" | "UNIFORM", number>;
  GPUMapMode: { READ: number };
};

export async function createWebGpuFrontierSession(
  transitionTable: Uint32Array,
  dimensions: {
    stateBuckets: number;
    purpleDimension: number;
    yellowDimension: number;
    stockIdSize: number;
  },
  maximumInputCount: number,
): Promise<WebGpuFrontierSession> {
  const gpu = (navigator as Navigator & { gpu?: NavigatorGpu }).gpu;
  if (!gpu) throw new Error("device_unavailable: navigator.gpu is not exposed");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("device_unavailable: no WebGPU adapter");
  if (adapter.limits.maxStorageBuffersPerShaderStage < 4) {
    throw new Error("device_unavailable: fewer than four storage buffers are supported");
  }
  const device = await adapter.requestDevice();
  let deviceLost: { message: string; reason: string } | null = null;
  void device.lost.then((value) => {
    deviceLost = value;
  });
  const globals = requireWebGpuGlobals();
  const usage = globals.GPUBufferUsage;
  const transitionBuffer = device.createBuffer({
    size: align4(transitionTable.byteLength),
    usage: usage.STORAGE | usage.COPY_DST,
  });
  device.queue.writeBuffer(transitionBuffer, 0, transitionTable);
  const pipeline = await device.createComputePipelineAsync({
    compute: {
      entryPoint: "main",
      module: device.createShaderModule({ code: COMPACT_FRONTIER_WGSL }),
    },
    layout: "auto",
  });

  const metadata: WebGpuFrontierMetadata = {
    adapter: adapterLabel(adapter),
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maximumInputCount,
    hashCapacity: 0,
    hashBytes: 0,
  };
  return {
    metadata,
    async expand(inputKeys) {
      if (deviceLost) throw new Error(`device_lost: ${deviceLost.reason}: ${deviceLost.message}`);
      if (inputKeys.length === 0) return [];
      if (inputKeys.length > maximumInputCount) {
        throw new Error(`Frontier has ${inputKeys.length} inputs, above ${maximumInputCount}.`);
      }
      const hashCapacity = hashCapacityForInput(inputKeys.length);
      const hashBytes = hashCapacity * Uint32Array.BYTES_PER_ELEMENT;
      if (
        hashBytes > adapter.limits.maxStorageBufferBindingSize ||
        hashBytes > adapter.limits.maxBufferSize
      ) {
        throw new Error(`device_unavailable: ${hashBytes} byte hash table exceeds adapter limits`);
      }
      metadata.hashCapacity = hashCapacity;
      metadata.hashBytes = hashBytes;
      const input = Uint32Array.from(inputKeys);
      const params = new Uint32Array([
        input.length,
        hashCapacity - 1,
        dimensions.purpleDimension,
        dimensions.yellowDimension,
        dimensions.stockIdSize,
        dimensions.stateBuckets,
        0,
        0,
      ]);
      const inputBuffer = device.createBuffer({
        size: align4(input.byteLength),
        usage: usage.STORAGE | usage.COPY_DST,
      });
      const hashBuffer = device.createBuffer({
        size: hashBytes,
        usage: usage.STORAGE | usage.COPY_SRC,
      });
      const counterBuffer = device.createBuffer({ size: 8, usage: usage.STORAGE | usage.COPY_SRC });
      const paramsBuffer = device.createBuffer({
        size: params.byteLength,
        usage: usage.UNIFORM | usage.COPY_DST,
      });
      const hashReadback = device.createBuffer({
        size: hashBytes,
        usage: usage.COPY_DST | usage.MAP_READ,
      });
      const counterReadback = device.createBuffer({
        size: 8,
        usage: usage.COPY_DST | usage.MAP_READ,
      });
      try {
        device.queue.writeBuffer(inputBuffer, 0, input);
        device.queue.writeBuffer(paramsBuffer, 0, params);
        const bindGroup = device.createBindGroup({
          entries: [
            { binding: 0, resource: { buffer: inputBuffer } },
            { binding: 1, resource: { buffer: transitionBuffer } },
            { binding: 2, resource: { buffer: hashBuffer } },
            { binding: 3, resource: { buffer: counterBuffer } },
            { binding: 4, resource: { buffer: paramsBuffer } },
          ],
          layout: pipeline.getBindGroupLayout(0),
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil((input.length * 3) / 128));
        pass.end();
        encoder.copyBufferToBuffer(hashBuffer, 0, hashReadback, 0, hashBytes);
        encoder.copyBufferToBuffer(counterBuffer, 0, counterReadback, 0, 8);
        device.queue.submit([encoder.finish()]);
        await Promise.all([
          hashReadback.mapAsync(globals.GPUMapMode.READ),
          counterReadback.mapAsync(globals.GPUMapMode.READ),
        ]);
        const counters = new Uint32Array(counterReadback.getMappedRange().slice(0));
        if ((counters[1] ?? 0) !== 0)
          throw new Error(`GPU hash insertion overflowed ${counters[1]} times.`);
        const stored = new Uint32Array(hashReadback.getMappedRange().slice(0));
        const keys = [...stored].filter((value) => value !== 0).map((value) => value - 1);
        keys.sort((left, right) => left - right);
        if (keys.length !== counters[0]) {
          throw new Error(`GPU inserted ${counters[0]} keys but read back ${keys.length}.`);
        }
        return keys;
      } finally {
        hashReadback.unmap();
        counterReadback.unmap();
        inputBuffer.destroy();
        hashBuffer.destroy();
        counterBuffer.destroy();
        paramsBuffer.destroy();
        hashReadback.destroy();
        counterReadback.destroy();
      }
    },
    close() {
      transitionBuffer.destroy();
      device.destroy();
    },
  };
}

export function hashCapacityForInput(inputCount: number): number {
  const required = Math.max(8, Math.ceil(Math.max(1, inputCount) * 12));
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function adapterLabel(adapter: AdapterLike): string {
  const info = adapter.info;
  return (
    [info?.vendor, info?.architecture, info?.device, info?.description].filter(Boolean).join(" ") ||
    "unknown"
  );
}

function requireWebGpuGlobals(): WebGpuGlobals {
  const globals = globalThis as Record<string, unknown>;
  const usage = requireRecord(globals["GPUBufferUsage"], "GPUBufferUsage");
  const mapMode = requireRecord(globals["GPUMapMode"], "GPUMapMode");
  return {
    GPUBufferUsage: {
      COPY_DST: requireNumber(usage, "COPY_DST"),
      COPY_SRC: requireNumber(usage, "COPY_SRC"),
      MAP_READ: requireNumber(usage, "MAP_READ"),
      STORAGE: requireNumber(usage, "STORAGE"),
      UNIFORM: requireNumber(usage, "UNIFORM"),
    },
    GPUMapMode: { READ: requireNumber(mapMode, "READ") },
  };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`device_unavailable: ${name} is not exposed`);
  }
  return value as Record<string, unknown>;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`device_unavailable: WebGPU constant ${key} is not numeric`);
  }
  return value;
}

function align4(value: number): number {
  return Math.max(4, Math.ceil(value / 4) * 4);
}
