import { describe, expect, it } from 'vitest';
import { isAllowedFileName, isValidProjectFile, readFirstBytes } from '@/lib/validation';

describe('validation', () => {
  describe('isAllowedFileName', () => {
    it('accepts .sb3 extension regardless of case', () => {
      expect(isAllowedFileName('project.SB3')).toBe('sb3');
      expect(isAllowedFileName('foo.sb3')).toBe('sb3');
    });
    it('accepts .sb2 and .sb', () => {
      expect(isAllowedFileName('old.sb2')).toBe('sb2');
      expect(isAllowedFileName('legacy.sb')).toBe('sb');
    });
    it('rejects unknown extensions', () => {
      expect(isAllowedFileName('image.png')).toBeNull();
      expect(isAllowedFileName('data.json')).toBeNull();
      expect(isAllowedFileName('noext')).toBeNull();
    });
  });

  describe('isValidProjectFile', () => {
    function makeFile(name: string, bytes: number[] = []): File {
      const arr = new Uint8Array(bytes);
      return new File([arr], name, { type: 'application/octet-stream' });
    }

    it('rejects .png files', async () => {
      expect(await isValidProjectFile(makeFile('image.png'))).toBe(false);
    });
    it('accepts .sb2/.sb without ZIP check', async () => {
      expect(await isValidProjectFile(makeFile('a.sb2', [1, 2, 3]))).toBe(true);
      expect(await isValidProjectFile(makeFile('a.sb', [1, 2, 3]))).toBe(true);
    });
    it('accepts .sb3 with valid ZIP magic', async () => {
      expect(await isValidProjectFile(makeFile('a.sb3', [0x50, 0x4b, 0x03, 0x04, 0x99]))).toBe(
        true,
      );
    });
    it('rejects .sb3 with wrong magic', async () => {
      expect(await isValidProjectFile(makeFile('a.sb3', [0xff, 0x00, 0x00, 0x00]))).toBe(false);
    });
    it('rejects .sb3 with fewer than 4 bytes', async () => {
      expect(await isValidProjectFile(makeFile('a.sb3', [0x50, 0x4b]))).toBe(false);
    });
  });

  describe('readFirstBytes', () => {
    it('reads requested number of bytes', async () => {
      const file = new File([new Uint8Array([10, 20, 30, 40, 50])], 'x.bin');
      const bytes = await readFirstBytes(file, 3);
      expect(Array.from(bytes)).toEqual([10, 20, 30]);
    });
  });
});
