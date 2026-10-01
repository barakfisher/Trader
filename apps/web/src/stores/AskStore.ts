import { makeAutoObservable, runInAction } from 'mobx';

import type { AskResponse } from '@traders/shared/ai';

import { api, errorMessage } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import type { RootStore } from './RootStore.ts';

/** The server's own bound on a question (`MAX_QUESTION_LENGTH` in `routes/ask.ts`). */
export const MAX_QUESTION_LENGTH = 1000;

export interface AskEntry {
  id: number;
  question: string;
  /** When it was sent, for the waiting line's seconds. */
  askedAt: number;
  response: AskResponse | null;
  /** A failure to get any reply - the network, a 5xx. A refusal is a response, never this. */
  error: string | null;
}

/**
 * This session's questions and their replies, newest first.
 *
 * A reply is the answer to one action, not a resource to refresh, so it lives
 * here rather than in the query cache (decision 64's exception): re-asking is a
 * new question - and on the free model a minute of waiting - never a background
 * re-read. One question at a time: a second press while a model is writing
 * would only queue behind it, and two answers arriving out of order would be
 * shown beside the wrong questions.
 */
export class AskStore {
  entries: AskEntry[] = [];
  draft = '';
  private nextId = 1;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get pending(): AskEntry | null {
    return this.entries.find((entry) => entry.response === null && entry.error === null) ?? null;
  }

  setDraft(text: string): void {
    this.draft = text;
  }

  async ask(): Promise<void> {
    const question = this.draft.trim();
    if (question === '' || question.length > MAX_QUESTION_LENGTH || this.pending) return;
    const entry: AskEntry = {
      id: this.nextId++,
      question,
      askedAt: Date.now(),
      response: null,
      error: null,
    };
    this.entries.unshift(entry);
    this.draft = '';
    try {
      const response = await api.post<AskResponse>('/ask', { question });
      runInAction(() => {
        this.update(entry.id, { response });
      });
    } catch (error) {
      runInAction(() => {
        this.update(entry.id, { error: errorMessage(error, t('errors.askFailed')) });
      });
    }
  }

  /** Put a failed question back in the box, so trying again is one press. */
  retry(id: number): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || this.pending) return;
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    this.draft = entry.question;
    void this.ask();
  }

  private update(id: number, patch: Partial<AskEntry>): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    // Gone if the session was reset while the answer was on its way: an answer
    // for a signed-out account must not reappear for the next.
    if (entry) Object.assign(entry, patch);
  }

  /** Signing out must not leave one account's questions on screen for the next. */
  reset(): void {
    this.entries = [];
    this.draft = '';
  }
}
