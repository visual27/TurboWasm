import { beforeEach, describe, expect, it } from 'vitest';
import {
  getCloudProvider,
  noopCloudProvider,
  resetCloudProvider,
  setCloudProvider,
  type CloudProvider,
} from '@/runtime/cloud-provider';

describe('cloud provider stub', () => {
  beforeEach(() => {
    resetCloudProvider();
  });

  it('defaults to noop provider', () => {
    expect(getCloudProvider()).toBe(noopCloudProvider);
  });

  it('allows replacing the provider', () => {
    const custom: CloudProvider = {
      id: 'custom',
      connect() {},
    };
    setCloudProvider(custom);
    expect(getCloudProvider().id).toBe('custom');
  });

  it('reset restores noop provider', () => {
    setCloudProvider({ id: 'tmp' });
    resetCloudProvider();
    expect(getCloudProvider()).toBe(noopCloudProvider);
  });
});
