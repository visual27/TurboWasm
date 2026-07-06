#!/usr/bin/env node
import { buildBenchTouching } from './gen-bench-sb3.mjs';

const project = buildBenchTouching();
const actor = project.targets.find(t => t.name === 'Actor');
console.log('Actor blocks:');
const entries = Object.entries(actor.blocks).sort(([a], [b]) => a.localeCompare(b));
for (const [id, blk] of entries) {
  if (!blk) {
    console.log(`  ${id}: (undefined)`);
    continue;
  }
  console.log(`  ${id}: opcode=${blk.opcode} next=${JSON.stringify(blk.next)} parent=${JSON.stringify(blk.parent)}`);
}
