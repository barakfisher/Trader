"""The assistant's conversations and messages (migration 0052).

Plain rows, read back as the history the next question is sent with and as the
transcript a person reviews. Every statement is scoped by `user_id`: a
conversation id from another user finds nothing, exactly as a missing one does,
so the router answers both with the same 404 and never confirms that someone
else's conversation exists. Listing and deleting conversations are the
orchestrator's (its own SQL, as for every table the screens read).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

#: Characters of the first question kept as a conversation's title.
TITLE_CHARS = 80


@dataclass(frozen=True)
class StoredMessage:
    id: str
    role: str
    content: str
    outcome: str | None
    reason: str | None
    sources: list[Any]
    suggestions: list[str]
    tool_calls: list[Any]
    created_at: datetime


@dataclass(frozen=True)
class Conversation:
    id: str
    title: str
    created_at: datetime
    updated_at: datetime


def title_for(question: str) -> str:
    one_line = " ".join(question.split())
    return one_line if len(one_line) <= TITLE_CHARS else one_line[: TITLE_CHARS - 1] + "…"


def start(connection: Connection, user_id: str, question: str) -> str:
    return connection.execute(
        text(
            "INSERT INTO assistant_conversations (user_id, title) "
            "VALUES (CAST(:user AS uuid), :title) RETURNING id::text"
        ),
        {"user": user_id, "title": title_for(question) or "Question"},
    ).scalar_one()


def find(connection: Connection, user_id: str, conversation_id: str) -> Conversation | None:
    row = connection.execute(
        text(
            """
            SELECT id::text AS id, title, created_at, updated_at
              FROM assistant_conversations
             WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user AS uuid)
            """
        ),
        {"id": conversation_id, "user": user_id},
    ).one_or_none()
    return Conversation(**row._mapping) if row else None


def messages(connection: Connection, user_id: str, conversation_id: str) -> list[StoredMessage]:
    rows = connection.execute(
        text(
            """
            SELECT id::text AS id, role, content, outcome, reason, sources, suggestions,
                   tool_calls, created_at
              FROM assistant_messages
             WHERE conversation_id = CAST(:id AS uuid) AND user_id = CAST(:user AS uuid)
             ORDER BY created_at, role DESC
            """
        ),
        {"id": conversation_id, "user": user_id},
    ).all()
    return [StoredMessage(**row._mapping) for row in rows]


def add_user_message(
    connection: Connection, user_id: str, conversation_id: str, content: str, at: datetime
) -> None:
    connection.execute(
        text(
            """
            INSERT INTO assistant_messages (conversation_id, user_id, role, content, created_at)
            VALUES (CAST(:conversation AS uuid), CAST(:user AS uuid), 'user', :content, :at)
            """
        ),
        {"conversation": conversation_id, "user": user_id, "content": content, "at": at},
    )


def add_reply(
    connection: Connection,
    *,
    user_id: str,
    conversation_id: str,
    content: str,
    outcome: str,
    reason: str | None,
    sources: list[Any],
    suggestions: list[str],
    tool_calls: list[Any],
    model: str | None,
    cost_micro_usd: int,
    at: datetime,
) -> str:
    message_id = connection.execute(
        text(
            """
            INSERT INTO assistant_messages
                (conversation_id, user_id, role, content, outcome, reason, sources,
                 suggestions, tool_calls, model, cost_micro_usd, created_at)
            VALUES (CAST(:conversation AS uuid), CAST(:user AS uuid), 'assistant', :content,
                    :outcome, :reason, CAST(:sources AS jsonb), CAST(:suggestions AS jsonb),
                    CAST(:tool_calls AS jsonb), :model, :cost, :at)
            RETURNING id::text
            """
        ),
        {
            "conversation": conversation_id,
            "user": user_id,
            "content": content,
            "outcome": outcome,
            "reason": reason,
            "sources": json.dumps(sources, ensure_ascii=False, default=str),
            "suggestions": json.dumps(suggestions, ensure_ascii=False),
            "tool_calls": json.dumps(tool_calls, ensure_ascii=False, default=str),
            "model": model,
            "cost": cost_micro_usd,
            "at": at,
        },
    ).scalar_one()
    connection.execute(
        text(
            "UPDATE assistant_conversations SET updated_at = :at "
            "WHERE id = CAST(:id AS uuid) AND user_id = CAST(:user AS uuid)"
        ),
        {"id": conversation_id, "user": user_id, "at": at},
    )
    return message_id
