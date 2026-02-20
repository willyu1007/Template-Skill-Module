/**
 * index.mjs
 * API Index test suite
 */
import * as apiIndexSmoke from './api-index-smoke.mjs';
import * as apiIndexFocused from './api-index-focused.mjs';
import * as qualityGateTests from './quality-gate-tests.mjs';

const TESTS = [apiIndexSmoke, apiIndexFocused, qualityGateTests];

export function run(ctx) {
  const results = [];
  for (const t of TESTS) {
    const name = t.name || 'unnamed-test';
    ctx.log(`[tests][api-index] start: ${name}`);
    const res = t.run(ctx);
    results.push(res);
    ctx.log(`[tests][api-index] done: ${name} (${res.status})`);
    if (res.status === 'FAIL') break;
  }
  return results;
}
