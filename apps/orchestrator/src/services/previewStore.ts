/**
 * Short-lived store for parsed-but-uncommitted imports.
 *
 * Deliberately in-process: a preview is a few seconds of user attention, and
 * keeping it out of Postgres avoids a table that would only ever hold garbage.
 * The tradeoff is that previews do not survive a restart and do not work across
 * replicas - acceptable while the orchestrator runs as a single instance, and
 * the reason the Kubernetes manifest keeps its replica count at 1 until this
 * moves to Redis.
 */

import { randomUUID } from 'node:crypto';

import type { ImportPreview } from '@traders/shared';

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 20;

interface Entry {
  preview: ImportPreview;
  userId: string;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(id);
  }
  // Bound memory even if a user uploads repeatedly without committing.
  while (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (!oldest) break;
    entries.delete(oldest[0]);
  }
}

export function savePreview(userId: string, preview: Omit<ImportPreview, 'previewId' | 'expiresAt'>): ImportPreview {
  evictExpired();
  const previewId = randomUUID();
  const expiresAt = Date.now() + TTL_MS;
  const stored: ImportPreview = {
    ...preview,
    previewId,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  entries.set(previewId, { preview: stored, userId, expiresAt });
  return stored;
}

export function getPreview(userId: string, previewId: string): ImportPreview | null {
  evictExpired();
  const entry = entries.get(previewId);
  if (!entry || entry.userId !== userId) return null;
  return entry.preview;
}

export function deletePreview(previewId: string): void {
  entries.delete(previewId);
}

export function clearPreviewsForTests(): void {
  entries.clear();
}
