import {
  FPS_MAX,
  FPS_MIN,
  STAGE_MAX_HEIGHT,
  STAGE_MAX_WIDTH,
  STAGE_MIN_HEIGHT,
  STAGE_MIN_WIDTH,
  VOLUME_MAX,
  VOLUME_MIN,
} from '@/utils/constants';

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampVolume(value: number): number {
  return Math.round(clamp(value, VOLUME_MIN, VOLUME_MAX));
}

export function clampFps(value: number): number {
  return Math.round(clamp(value, FPS_MIN, FPS_MAX));
}

export function clampStageWidth(value: number): number {
  return Math.round(clamp(value, STAGE_MIN_WIDTH, STAGE_MAX_WIDTH));
}

export function clampStageHeight(value: number): number {
  return Math.round(clamp(value, STAGE_MIN_HEIGHT, STAGE_MAX_HEIGHT));
}

export function formatInteger(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : '0';
}