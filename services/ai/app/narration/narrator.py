"""Turn a finding into a sentence a person can act on - or refuse to.

The pipeline is deliberately shaped so that the model is the *last* contributor
and the least trusted one. The finding is computed, the evidence is assembled,
the deterministic narration already exists and is correct. The model is then
offered the chance to say it better, and that offer is withdrawn the moment it
says something the evidence does not support.

Failure is therefore uneventful: no LLM configured, no budget left, a timeout, a
refusal, or an unsupported figure all end in the same place - the template. The
observation is written either way, and `narration_source` records which author
produced the words, so a reader and a later audit can tell.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal

from app.analysis.findings import Finding
from app.core.logging import get_logger
from app.llm.base import (
    NO_REASONING,
    LLMBudgetExceededError,
    LLMError,
    LLMProvider,
    LLMUnavailableError,
)
from app.narration.correlation import CandidateArticle, as_evidence
from app.narration.evidence_validator import is_supported
from app.narration.templates import concepts_for, explanation_for, headline_for

log = get_logger("narration")

NarrationSource = Literal["llm", "template"]

#: Why a narration fell back, recorded on the observation so the rate is
#: measurable rather than anecdotal.
FallbackReason = Literal[
    "none", "no_provider", "budget_exhausted", "provider_error", "unsourced_figures", "malformed"
]

SYSTEM_PROMPT = """You explain movements in someone's investment portfolio.

Rules, in order of importance:

1. Use ONLY the numbers in the evidence you are given. Never introduce a figure
   that is not there - not a price, not a percentage, not a market
   capitalisation, not a date. If you want to state a number and it is not in
   the evidence, leave it out of the sentence.
2. Never give advice, never predict, never suggest an action. No price targets,
   no "consider trimming", no "this may continue". You describe what happened
   and what the terms mean.
3. If articles are supplied, they are context that was published near the move,
   not a proven cause. Write "coincided with" or "was reported alongside",
   never "because of" or "caused by".
4. Plain English. No jargon without a short gloss. No enthusiasm.

Reply with JSON only: {"headline": "...", "explanation": "..."}
The headline is one line under 100 characters. The explanation is two or three
sentences."""


@dataclass(frozen=True, slots=True)
class Narration:
    headline: str
    explanation: str
    concepts: tuple[str, ...]
    evidence: dict[str, object]
    source: NarrationSource
    fallback_reason: FallbackReason = "none"


def build_evidence(finding: Finding, articles: list[CandidateArticle]) -> dict[str, object]:
    """The evidence stored on the observation and validated against.

    Articles are folded in so that a headline quoted in an explanation is
    traceable, and so that figures inside a quoted headline do not read as
    invention to the validator.
    """
    evidence = dict(finding.evidence)
    if articles:
        evidence["articles"] = as_evidence(articles)
    return evidence


def _template(finding: Finding, evidence: dict[str, object], reason: FallbackReason) -> Narration:
    return Narration(
        headline=headline_for(finding),
        explanation=explanation_for(finding),
        concepts=concepts_for(finding),
        evidence=evidence,
        source="template",
        fallback_reason=reason,
    )


def _user_prompt(finding: Finding, evidence: dict[str, object]) -> str:
    return (
        f"Finding: {finding.kind} (severity {finding.severity}) for {finding.subject_ref}, "
        f"observed {finding.as_of.isoformat()}.\n\n"
        f"Evidence:\n{json.dumps(evidence, indent=2, default=str)}\n\n"
        "Write the headline and explanation."
    )


async def narrate(
    finding: Finding,
    articles: list[CandidateArticle],
    llm: LLMProvider | None,
    *,
    temperature: float = 0.1,
) -> Narration:
    """Narrate `finding`, falling back to the template on any doubt."""
    evidence = build_evidence(finding, articles)

    if llm is None:
        return _template(finding, evidence, "no_provider")

    try:
        completion = await llm.complete(
            system=SYSTEM_PROMPT,
            user=_user_prompt(finding, evidence),
            temperature=temperature,
            # Narration does not think, and says so here rather than relying on
            # a deployment setting. It restates figures it is forbidden to alter
            # under rules it is given, so there is no judgement for reasoning to
            # improve - and what makes the sentence trustworthy is the evidence
            # validator below, not the model's deliberation.
            #
            # On a reasoning model the cost of leaving it on is not a slower
            # answer but no answer: the thinking is billed out of the same
            # output budget, and a reply truncated mid-thought comes back with
            # the reasoning in place of the JSON. Measured on a free route at
            # 1707 reasoning tokens against 700.
            #
            # A caller with a real judgement to make - `/ask` deciding whether
            # its retrieved context supports an answer at all - should pass its
            # own value, or none and inherit the deployment default.
            reasoning_effort=NO_REASONING,
        )
    except LLMError as error:
        # The null provider raises Unavailable, so "no LLM configured" arrives
        # here rather than being special-cased above: one path, one behaviour.
        reason: FallbackReason = _reason_for(error)
        log.warning("narration.llm_unavailable", reason=reason, error=str(error))
        return _template(finding, evidence, reason)

    parsed = _parse(completion.text)
    if parsed is None:
        log.warning("narration.malformed_response", text=completion.text[:200])
        return _template(finding, evidence, "malformed")

    headline, explanation = parsed
    # One check over both fields: a supported headline with an invented figure in
    # the explanation is not a partial success.
    if not is_supported(f"{headline}\n{explanation}", evidence):
        log.warning(
            "narration.rejected",
            subject=finding.subject_ref,
            kind=finding.kind,
            model=completion.model,
        )
        return _template(finding, evidence, "unsourced_figures")

    log.info(
        "narration.accepted",
        subject=finding.subject_ref,
        model=completion.model,
        cost_micro_usd=completion.estimated_cost_micro_usd,
    )
    return Narration(
        headline=headline.strip(),
        explanation=explanation.strip(),
        concepts=concepts_for(finding),
        evidence=evidence,
        source="llm",
    )


def _reason_for(error: LLMError) -> FallbackReason:
    if isinstance(error, LLMUnavailableError):
        return "no_provider"
    if isinstance(error, LLMBudgetExceededError):
        return "budget_exhausted"
    return "provider_error"


def _parse(text: str) -> tuple[str, str] | None:
    """Pull the two fields out of the model's reply.

    Tolerates a fenced code block, because models add them regardless of
    instructions, but not a missing field: a narration without an explanation is
    not something to paper over with an empty string.
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    headline = payload.get("headline")
    explanation = payload.get("explanation")
    if not isinstance(headline, str) or not isinstance(explanation, str):
        return None
    if not headline.strip() or not explanation.strip():
        return None
    return headline, explanation
