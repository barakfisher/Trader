/**
 * How long a test waits for something to appear before calling it absent.
 *
 * `findBy*` and `waitFor` give up after a wall-clock budget, and Testing
 * Library's default is one second. A page under test reaches its state after a
 * fixed amount of *work* - render, fetch through the mock, render again - which
 * takes about 100 ms on an idle machine and has no time bound on a busy one.
 * `pnpm -r test` runs the web, orchestrator and shared suites at once, each
 * with a worker per core, so the web suite routinely gets a fraction of a CPU.
 * Measured on 2026-10-23: 13 of 20 full runs failed on a one-second budget,
 * every failure "unable to find" an element that the same test finds alone; the
 * Settings key card, two dependent requests deep, failed most.
 *
 * The budget bounds *never*, not *how fast*: no assertion depends on it, and a
 * test that passes waits no longer than its page takes. A broken page still
 * fails, after this budget rather than after one second. Vitest's own timeout
 * is set above it (vitest.config.ts) so that a test which runs out reports
 * Testing Library's error - the DOM it was looking at - rather than a bare
 * "test timed out".
 */

import { configure } from '@testing-library/dom';

export const DOM_WAIT_BUDGET_MS = 10_000;

configure({ asyncUtilTimeout: DOM_WAIT_BUDGET_MS });
