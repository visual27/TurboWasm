import { describe, expect, it } from 'vitest';
import {
  clamp,
  clampFps,
  clampStageHeight,
  clampStageWidth,
  clampVolume,
  formatInteger,
} from '@/utils/format';
import { DEFAULT_ADVANCED_SETTINGS } from '@/utils/constants';

describe('format utilities', () => {
  describe('clamp', () => {
    it('returns value when within range', () => {
      expect(clamp(5, 1, 10)).toBe(5);
    });
    it('returns min when below range', () => {
      expect(clamp(-5, 0, 10)).toBe(0);
    });
    it('returns max when above range', () => {
      expect(clamp(15, 0, 10)).toBe(10);
    });
    it('returns min for NaN', () => {
      expect(clamp(Number.NaN, 2, 8)).toBe(2);
    });
  });

  describe('clampVolume', () => {
    it('clamps and rounds', () => {
      expect(clampVolume(-10)).toBe(0);
      expect(clampVolume(150)).toBe(100);
      expect(clampVolume(45.6)).toBe(46);
      expect(clampVolume(NaN)).toBe(0);
    });
  });

  describe('clampFps', () => {
    it('respects 1..240 range', () => {
      expect(clampFps(0)).toBe(1);
      expect(clampFps(300)).toBe(240);
      expect(clampFps(60)).toBe(60);
      expect(clampFps(NaN)).toBe(1);
    });
  });

  describe('clampStageWidth/Height', () => {
    it('respects 1..8192 range', () => {
      expect(clampStageWidth(0)).toBe(1);
      expect(clampStageWidth(99999)).toBe(8192);
      expect(clampStageWidth(480)).toBe(480);
      expect(clampStageHeight(NaN)).toBe(1);
    });
  });

  describe('formatInteger', () => {
    it('rounds finite numbers', () => {
      expect(formatInteger(3.4)).toBe('3');
      expect(formatInteger(3.6)).toBe('4');
    });
    it('falls back to 0 for non-finite', () => {
      expect(formatInteger(NaN)).toBe('0');
      expect(formatInteger(Infinity)).toBe('0');
    });
  });

  describe('DEFAULT_ADVANCED_SETTINGS', () => {
    it('matches documented defaults', () => {
      expect(DEFAULT_ADVANCED_SETTINGS).toMatchObject({
        fps: 30,
        stageWidth: 480,
        stageHeight: 360,
        interpolation: false,
        turboMode: false,
        disableCompiler: false,
      });
    });
  });
});