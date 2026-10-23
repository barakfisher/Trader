import { makeAutoObservable, runInAction } from 'mobx';

import type { AssistantConversationResponse, AssistantReplyView } from '@traders/shared';

import { api, errorMessage } from '../api/client.ts';
import { t } from '../i18n/index.ts';
import { queryKeys } from '../queries/queryKeys.ts';
import type { RootStore } from './RootStore.ts';

/** The server's own bound on a message (`MAX_MESSAGE_LENGTH` in `routes/assistant.ts`). */
export const MAX_QUESTION_LENGTH = 2000;

export interface AskTurn {
  id: number;
  question: string;
  /** When it was sent, for the waiting line's seconds; null for a turn read back. */
  askedAt: number | null;
  reply: AssistantReplyView | null;
  /** When a stored reply was written; null for one that arrived on this screen (now). */
  repliedAt: string | null;
  /** A failure to get any reply - the network, a 5xx. A decline is a reply, never this. */
  error: string | null;
}

/**
 * The conversation on screen: its id, its turns oldest first, and the question
 * in the box.
 *
 * Sending is an action, not a resource to refresh, so it lives here rather than
 * in the query cache (decision 64's exception); the list of conversations is a
 * resource, and is read through the cache and invalidated when one changes.
 * One question at a time: the assistant answers in order, and a second question
 * sent before the first is answered would be asked without it.
 */
export class AskStore {
  conversationId: string | null = null;
  turns: AskTurn[] = [];
  draft = '';
  /** A conversation being read back from the server; null when none is. */
  opening: string | null = null;
  openError: string | null = null;
  private nextId = 1;

  constructor(private readonly root: RootStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get pending(): AskTurn | null {
    return this.turns.find((turn) => turn.reply === null && turn.error === null) ?? null;
  }

  setDraft(text: string): void {
    this.draft = text;
  }

  async send(): Promise<void> {
    const question = this.draft.trim();
    if (question === '' || question.length > MAX_QUESTION_LENGTH || this.pending || this.opening) return;
    const turn: AskTurn = {
      id: this.nextId++,
      question,
      askedAt: Date.now(),
      reply: null,
      repliedAt: null,
      error: null,
    };
    const conversationId = this.conversationId;
    this.turns.push(turn);
    this.draft = '';
    try {
      const reply = await api.post<AssistantReplyView>('/assistant/messages', {
        message: question,
        ...(conversationId ? { conversationId } : {}),
      });
      runInAction(() => {
        // Gone if the conversation changed while the answer was on its way.
        const current = this.turns.find((candidate) => candidate.id === turn.id);
        if (!current) return;
        current.reply = reply;
        if (this.conversationId === conversationId && reply.conversationId) {
          this.conversationId = reply.conversationId;
        }
      });
      void this.root.queryClient.invalidateQueries({ queryKey: queryKeys.assistantConversations });
    } catch (error) {
      runInAction(() => {
        const current = this.turns.find((candidate) => candidate.id === turn.id);
        if (current) current.error = errorMessage(error, t('errors.askFailed'));
      });
    }
  }

  /** Put a failed question back in the box, so trying again is one press. */
  retry(id: number): void {
    const turn = this.turns.find((candidate) => candidate.id === id);
    if (!turn || this.pending) return;
    this.turns = this.turns.filter((candidate) => candidate.id !== id);
    this.draft = turn.question;
    void this.send();
  }

  /** Read a conversation back, replacing what is on screen. */
  async open(conversationId: string): Promise<void> {
    if (this.pending) return;
    this.opening = conversationId;
    this.openError = null;
    try {
      const body = await api.get<AssistantConversationResponse>(`/assistant/conversations/${conversationId}`);
      runInAction(() => {
        if (this.opening !== conversationId) return;
        this.conversationId = conversationId;
        this.turns = pairTurns(body, () => this.nextId++);
        this.opening = null;
      });
    } catch (error) {
      runInAction(() => {
        if (this.opening !== conversationId) return;
        this.opening = null;
        this.openError = errorMessage(error, t('ask.openFailed'));
      });
    }
  }

  startNew(): void {
    if (this.pending) return;
    this.conversationId = null;
    this.turns = [];
    this.opening = null;
    this.openError = null;
  }

  /** "Delete this conversation": gone from the server, and from the screen if it is open. */
  async remove(conversationId: string): Promise<void> {
    await api.delete(`/assistant/conversations/${conversationId}`);
    runInAction(() => {
      if (this.conversationId === conversationId) this.startNew();
    });
    await this.root.queryClient.invalidateQueries({ queryKey: queryKeys.assistantConversations });
  }

  /** Signing out must not leave one account's conversation on screen for the next. */
  reset(): void {
    this.conversationId = null;
    this.turns = [];
    this.draft = '';
    this.opening = null;
    this.openError = null;
  }
}

/** Each question with the reply that followed it; a question left without one keeps none. */
function pairTurns(body: AssistantConversationResponse, nextId: () => number): AskTurn[] {
  const turns: AskTurn[] = [];
  for (const message of body.messages) {
    if (message.role === 'user') {
      turns.push({ id: nextId(), question: message.text, askedAt: null, reply: null, repliedAt: null, error: null });
      continue;
    }
    const last = turns[turns.length - 1];
    if (!last || last.reply !== null || message.outcome === null) continue;
    last.repliedAt = message.createdAt;
    last.reply = {
      conversationId: body.conversation.id,
      messageId: message.id,
      outcome: message.outcome,
      reason: message.reason,
      text: message.text,
      sources: message.sources,
      suggestions: message.suggestions,
      // A stored answer does not record whether it ran on a fallback; only a fresh reply says (D283).
      fallbackFrom: null,
    };
  }
  // A question whose reply never arrived is shown as such, not as still waiting.
  for (const turn of turns) {
    if (turn.reply === null) turn.error = t('ask.noReplyStored');
  }
  return turns;
}
