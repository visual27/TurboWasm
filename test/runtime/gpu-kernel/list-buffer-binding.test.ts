import { beforeEach, describe, expect, it } from 'vitest';
import {
  BYTES_PER_ELEMENT,
  GpuLikeDevice,
  ListBufferPool,
} from '@/runtime/gpu-kernel/list-buffer-binding';
import type { BindDirective } from '@/runtime/gpu-kernel/types';

class MockGpuBuffer {
  public destroyed = false;
  public written: { offset: number; bytes: Uint8Array } | null = null;
  constructor(public size: number, public usage: number) {}
  destroy(): void {
    this.destroyed = true;
  }
  readBytes(): Uint8Array {
    if (!this.written) return new Uint8Array(this.size);
    const out = new Uint8Array(this.size);
    out.set(this.written.bytes, this.written.offset);
    return out;
  }
}

interface MockDevice extends GpuLikeDevice {
  __buffers: MockGpuBuffer[];
  __writes: { buffer: MockGpuBuffer; offset: number; bytes: Uint8Array }[];
  __submits: number;
}

function makeMockDevice(): MockDevice {
  const buffers: MockGpuBuffer[] = [];
  const writes: { buffer: MockGpuBuffer; offset: number; bytes: Uint8Array }[] = [];
  const device: MockDevice = {
    __buffers: buffers,
    __writes: writes,
    __submits: 0,
    queue: {
      writeBuffer: (buffer, offset, data) => {
        const buf = buffer as MockGpuBuffer;
        writes.push({
          buffer: buf,
          offset,
          bytes: new Uint8Array(
            (data as Uint8Array).buffer,
            (data as Uint8Array).byteOffset,
            (data as Uint8Array).byteLength,
          ),
        });
        buf.written = {
          offset,
          bytes: new Uint8Array(
            (data as Uint8Array).buffer,
            (data as Uint8Array).byteOffset,
            (data as Uint8Array).byteLength,
          ),
        };
      },
      submit: () => {
        device.__submits += 1;
      },
    },
    createBuffer: (desc) => {
      const buf = new MockGpuBuffer(desc.size, desc.usage);
      buffers.push(buf);
      return buf;
    },
  };
  return device;
}

function makeBind(name: string, opts: Partial<BindDirective> = {}): BindDirective {
  return {
    kind: 'bind',
    name,
    slot: opts.slot ?? 0,
    readOnly: opts.readOnly ?? false,
    dtype: opts.dtype ?? 'f32',
    line: 0,
    column: 0,
  };
}

describe('ListBufferPool', () => {
  let device: MockDevice;
  let pool: ListBufferPool;

  beforeEach(() => {
    device = makeMockDevice();
    pool = new ListBufferPool({ device });
  });

  it('lazily allocates a GPU buffer on first sync', () => {
    const binding = pool.bind(makeBind('scratch'));
    expect(binding.gpuBuffer).toBeNull();

    binding.syncFromHost([1, 2, 3]);
    expect(binding.gpuBuffer).not.toBeNull();
    expect(binding.length).toBe(3);
    expect(device.__buffers).toHaveLength(1);
    expect(device.__writes).toHaveLength(1);
    const firstWrite = device.__writes[0];
    expect(firstWrite).toBeDefined();
    expect(Array.from(firstWrite!.bytes)).toEqual([
      0x00,
      0x00,
      0x80,
      0x3f, // 1.0
      0x00,
      0x00,
      0x00,
      0x40, // 2.0
      0x00,
      0x00,
      0x40,
      0x40, // 3.0
    ]);
  });

  it('syncToHost returns the host-side mirror synchronously', () => {
    const binding = pool.bind(makeBind('scratch'));
    binding.syncFromHost(Float32Array.from([4, 5, 6, 7]));
    const result = binding.syncToHost();
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result as Float32Array)).toEqual([4, 5, 6, 7]);
  });

  it('reuses the GPU buffer on subsequent syncs of the same length', () => {
    const binding = pool.bind(makeBind('scratch'));
    binding.syncFromHost([1, 2, 3]);
    binding.syncFromHost([4, 5, 6]);
    expect(device.__buffers).toHaveLength(1);
    expect(device.__writes).toHaveLength(2);
  });

  it('reallocates when the requested length grows beyond the buffer size', () => {
    const binding = pool.bind(makeBind('scratch'));
    binding.syncFromHost(new Array(4).fill(1));
    const first = binding.gpuBuffer as MockGpuBuffer;
    binding.syncFromHost(new Array(32).fill(2));
    expect(first.destroyed).toBe(true);
    expect(device.__buffers).toHaveLength(2);
    expect(binding.length).toBe(32);
  });

  it('forDeviceLost drops every GPU buffer but keeps the metadata', () => {
    const a = pool.bind(makeBind('a', { slot: 1 }));
    const b = pool.bind(makeBind('b', { slot: 2 }));
    a.syncFromHost([1]);
    b.syncFromHost([2]);
    const bufferA = a.gpuBuffer as MockGpuBuffer;
    const bufferB = b.gpuBuffer as MockGpuBuffer;
    pool.forDeviceLost();
    expect(bufferA.destroyed).toBe(true);
    expect(bufferB.destroyed).toBe(true);
    expect(a.gpuBuffer).toBeNull();
    expect(b.gpuBuffer).toBeNull();
    expect(pool.size()).toBe(2);

    // Next sync lazily reallocates.
    a.syncFromHost([3]);
    expect(a.gpuBuffer).not.toBeNull();
    expect(device.__buffers).toHaveLength(3);
  });

  it('rebind destroys the previous buffer and resets metadata', () => {
    const binding = pool.bind(makeBind('scratch', { slot: 0, dtype: 'f32' }));
    binding.syncFromHost([1, 2]);
    const firstBuffer = binding.gpuBuffer as MockGpuBuffer;
    const rebound = pool.bind(makeBind('scratch', { slot: 5, dtype: 'i32' }));
    expect(rebound).toBe(binding);
    expect(firstBuffer.destroyed).toBe(true);
    expect(binding.slot).toBe(5);
    expect(binding.dtype).toBe('i32');
    expect(binding.gpuBuffer).toBeNull();
    expect(binding.length).toBe(0);
  });

  it('coerces number[] to the requested dtype', () => {
    const f32 = pool.bind(makeBind('a', { dtype: 'f32' }));
    f32.syncFromHost([1.5, 2.5]);
    expect(Array.from(f32.syncToHost() as Float32Array)).toEqual([1.5, 2.5]);

    const i32 = pool.bind(makeBind('b', { dtype: 'i32' }));
    i32.syncFromHost([10, 20]);
    expect(Array.from(i32.syncToHost() as Int32Array)).toEqual([10, 20]);

    const byte = pool.bind(makeBind('c', { dtype: 'byte' }));
    byte.syncFromHost([255, 0, 128]);
    expect(Array.from(byte.syncToHost() as Uint8Array)).toEqual([255, 0, 128]);
  });

  it('byte dtype uploads as u32 cells (one byte per cell, packed in low 8 bits)', () => {
    const byte = pool.bind(makeBind('c', { dtype: 'byte' }));
    byte.syncFromHost([255, 0, 128]);
    expect(byte.length).toBe(3);
    const buf = byte.gpuBuffer as MockGpuBuffer;
    // Physical size is 3 elements * 4 bytes = 12 bytes.
    expect(buf.size).toBe(3 * BYTES_PER_ELEMENT.byte);
    const write = device.__writes[0];
    expect(write).toBeDefined();
    // Uploaded view is 3 u32 cells: 0x000000ff, 0x00000000, 0x00000080.
    expect(write!.bytes.byteLength).toBe(12);
    const view = new DataView(write!.bytes.buffer, write!.bytes.byteOffset, write!.bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(255);
    expect(view.getUint32(4, true)).toBe(0);
    expect(view.getUint32(8, true)).toBe(128);
  });

  it('handles a null device without throwing', () => {
    const noDevice = new ListBufferPool({ device: null });
    const binding = noDevice.bind(makeBind('scratch'));
    expect(() => binding.syncFromHost([1, 2, 3])).not.toThrow();
    expect(binding.gpuBuffer).toBeNull();
    expect(Array.from(binding.syncToHost() as Float32Array)).toEqual([1, 2, 3]);
  });

  it('setDevice clears all GPU buffers when the device changes', () => {
    const binding = pool.bind(makeBind('scratch'));
    binding.syncFromHost([1, 2]);
    const firstBuffer = binding.gpuBuffer as MockGpuBuffer;
    const device2 = makeMockDevice();
    pool.setDevice(device2);
    expect(firstBuffer.destroyed).toBe(true);
    expect(binding.gpuBuffer).toBeNull();
  });

  it('clear drops every binding (project reload)', () => {
    pool.bind(makeBind('a')).syncFromHost([1, 2]);
    pool.bind(makeBind('b')).syncFromHost([3, 4]);
    expect(pool.size()).toBe(2);
    pool.clear();
    expect(pool.size()).toBe(0);
  });
});
