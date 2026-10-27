/**
 * The agent review's suggestions on the agent page (D340-D343): the open ones,
 * and the user's Apply or Dismiss. Apply writes the one setting the suggestion
 * names and answers the agent as it now is; nothing else changes it.
 */

import type { Hono } from 'hono';

import type { AgentSuggestion, AgentSuggestionsResponse, SuggestionEvidence } from '@traders/shared';

import {
  applySuggestion,
  dismissSuggestion,
  getAgent,
  listOpenSuggestions,
  type AgentRow,
  type AgentSuggestionRow,
} from '../../db/queries.js';
import { currentUserId, type AppEnv } from '../app.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { agentIdFrom, toAgentView } from './agents.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function suggestionIdFrom(raw: string | undefined): string {
  if (!raw || !UUID.test(raw)) throw badRequest('invalid_suggestion_id', 'expected a suggestion id');
  return raw;
}

function simulated(agent: AgentRow | null): AgentRow {
  if (!agent) throw notFound('agent not found');
  if (agent.is_primary) throw conflict('primary_agent_is_passive', 'the real portfolio is never reviewed: it never trades');
  return agent;
}

export function toSuggestionView(row: AgentSuggestionRow): AgentSuggestion {
  return {
    id: row.id,
    rule: row.rule as AgentSuggestion['rule'],
    status: row.status as AgentSuggestion['status'],
    createdAt: row.created_at.toISOString(),
    evidence: row.evidence as unknown as SuggestionEvidence,
    change: row.change,
  };
}

export function registerAgentSuggestionRoutes(app: Hono<AppEnv>): void {
  app.get('/agents/:id/suggestions', async (context) => {
    const userId = currentUserId(context);
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    const body: AgentSuggestionsResponse = {
      suggestions: (await listOpenSuggestions(userId, agent.id)).map(toSuggestionView),
    };
    return context.json(body);
  });

  app.post('/agents/:id/suggestions/:suggestionId/apply', async (context) => {
    const userId = currentUserId(context);
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    const suggestionId = suggestionIdFrom(context.req.param('suggestionId'));
    const result = await applySuggestion(userId, agent.id, suggestionId);
    switch (result.status) {
      case 'not_found':
        throw notFound('suggestion not found');
      case 'closed':
        throw conflict('suggestion_closed', 'this suggestion was already applied, dismissed or replaced');
      case 'nothing_to_apply':
        throw conflict('nothing_to_apply', 'this suggestion proposes no setting change; dismiss it instead');
      case 'agent_archived':
        throw conflict('agent_archived', 'an archived agent is read-only history; restore it to change a setting');
      case 'stale':
        throw conflict('suggestion_stale', 'the setting changed since the review; nothing was applied');
      case 'applied': {
        const after = await getAgent(userId, agent.id);
        if (!after) throw notFound('agent not found');
        return context.json(toAgentView(after));
      }
    }
  });

  app.post('/agents/:id/suggestions/:suggestionId/dismiss', async (context) => {
    const userId = currentUserId(context);
    const agent = simulated(await getAgent(userId, agentIdFrom(context.req.param('id'))));
    const suggestionId = suggestionIdFrom(context.req.param('suggestionId'));
    if (!(await dismissSuggestion(userId, agent.id, suggestionId))) throw notFound('no open suggestion by that id');
    return context.body(null, 204);
  });
}
