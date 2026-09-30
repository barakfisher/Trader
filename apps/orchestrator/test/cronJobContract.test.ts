/**
 * In a cluster the CronJobs in infra/k8s/base/cronjobs.yaml replace the local
 * timer (scheduler.ts), so the two must offer the same run kinds at the same
 * rhythm. Without this test, a run kind added to the scheduler would run on
 * every developer machine and silently never in a cluster - and nothing would
 * say so, because a run that never fires looks exactly like a quiet market.
 *
 * The manifest is read with a few regular expressions rather than a YAML
 * parser: the fields checked are one line each, and the file's shape is its
 * own contract (one CronJob per document, `schedule` and `RUN_KIND` in it).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { INTERVALS_MS } from '../src/scheduler.js';

const MANIFEST = readFileSync(
  new URL('../../../infra/k8s/base/cronjobs.yaml', import.meta.url),
  'utf8',
);

interface CronJob {
  name: string;
  kind: string;
  minutes: number[];
  hourField: string;
}

function parseCronJobs(text: string): CronJob[] {
  return text
    .split(/^---$/m)
    .filter((doc) => /^kind: CronJob$/m.test(doc))
    .map((doc) => {
      const name = /^ {2}name: (\S+)$/m.exec(doc)?.[1] ?? '';
      const kind = /name: RUN_KIND\n\s+value: (\S+)/.exec(doc)?.[1] ?? '';
      const schedule = /^ {2}schedule: '([^']+)'$/m.exec(doc)?.[1] ?? '';
      const [minuteField = '', hourField = ''] = schedule.split(' ');
      return { name, kind, minutes: minuteField.split(',').map(Number), hourField };
    });
}

const cronJobs = parseCronJobs(MANIFEST);

describe('CronJobs match the local scheduler', () => {
  it('has exactly one CronJob per run kind the scheduler offers', () => {
    expect(cronJobs.map((job) => job.kind).sort()).toEqual(Object.keys(INTERVALS_MS).sort());
  });

  it('asks at the same rhythm as the local timer', () => {
    for (const job of cronJobs) {
      // Minutes past every hour, evenly spaced: 60 / (asks per hour) is the interval.
      expect(job.hourField, job.name).toBe('*');
      const intervalMinutes = 60 / job.minutes.length;
      expect(intervalMinutes * 60_000, job.name).toBe(INTERVALS_MS[job.kind]);
      const gaps = job.minutes.map((minute, i) => (job.minutes[(i + 1) % job.minutes.length]! - minute + 60) % 60);
      expect(new Set(gaps.length > 1 ? gaps : [60]), job.name).toEqual(new Set([intervalMinutes]));
    }
  });

  it('keeps the start order: backfill first, the digest last', () => {
    const firstMinute = (kind: string) => cronJobs.find((job) => job.kind === kind)!.minutes[0]!;
    const others = cronJobs.filter((job) => !['backfill', 'daily_digest'].includes(job.kind));
    for (const job of others) {
      expect(firstMinute('backfill'), job.name).toBeLessThan(job.minutes[0]!);
      expect(firstMinute('daily_digest'), job.name).toBeGreaterThan(job.minutes[0]!);
    }
  });

  it('names each CronJob after its kind', () => {
    for (const job of cronJobs) {
      expect(job.name).toBe(`run-${job.kind.replaceAll('_', '-')}`);
    }
  });
});
