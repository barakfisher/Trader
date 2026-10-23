"""Who pays for a user's model call: the installation for the admin, the user's own key
for everyone else, and nobody when that key is missing, refused or past its limit (D245).

**The admin runs on the installation's key** and its daily ceiling
(`LLM_DAILY_BUDGET_USD`), as before. **Every other user runs on their own
OpenRouter key only** (D206's key, D245's rule): with no key saved, or one
OpenRouter has refused (`rejected`, `no_credit`, D207), the call is not made
and nothing falls back to the installation's key. Calls for no user - the
installation's own work (D238) - and calls to a provider that does not charge
per token (a local Ollama, or none at all) are not the installation's money
and are not gated.

**A user's optional monthly safety limit** (D250) bounds what this app spends
on their key: `user_settings.llm_safety_limit_micro_usd`, counted in the
user's calendar month over the calls `paid_by = 'own_key'`. It is a brake
against a runaway loop, beside OpenRouter's own limit on the key (D211), and
it binds even a key with no limit at all. It is enforced before each call by
`MonthlyCapProvider` (`monthly_cap.py`), whose ledger here is
`DatabaseSafetyLimitLedger`; the admin cap it was written for is retired
(D274), and its refusal, `cap_reached`, now means "your safety limit".

`PayerGate.refusal` answers the same question before any work starts, so a
scan, a re-check or an instructions check is refused with a reason the screen
can say (D245) - and a scheduled scan is skipped rather than run and failed.
The provider chain (`own_key.OwnKeyProvider`) enforces it again on every call,
because narration and tool-loop turns never pass through a router.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from app.llm.monthly_cap import CapLedger
from app.llm.own_key import OwnKeyStore, UsableKey

#: Why a user's call may not be made. `own_key_required`: no key that can be
#: used (none saved, or this installation cannot use saved keys);
#: `own_key_failed`: OpenRouter refused the saved key; `safety_limit_reached`:
#: the user's own monthly limit is spent.
PayerRefusal = Literal["own_key_required", "own_key_failed", "safety_limit_reached"]
KeyRefusal = Literal["own_key_required", "own_key_failed"]


@dataclass(frozen=True)
class Payer:
    """What pays for one user's calls: the installation, their key, or - with a
    refusal - nothing."""

    installation: bool = False
    key: UsableKey | None = None
    refusal: KeyRefusal | None = None


INSTALLATION = Payer(installation=True)


class PayerGate:
    """The payer rule, for the provider chain and for the routers alike.

    `own_keys_usable` is false when this installation cannot use a saved key at
    all - a provider other than OpenRouter, or no `LLM_KEY_ENCRYPTION_KEYS` - and
    then no user but the admin has a payer.
    """

    def __init__(self, store: OwnKeyStore, ledger: CapLedger, *, own_keys_usable: bool) -> None:
        self.store = store
        self.ledger = ledger
        self._own_keys_usable = own_keys_usable

    def payer(self, user_id: str) -> Payer:
        payer = self.store.payer(user_id)
        if payer.installation or payer.refusal is not None:
            return payer
        if not self._own_keys_usable or payer.key is None:
            return Payer(refusal="own_key_required")
        return payer

    def refusal(
        self, user_id: str, *, metered: bool, now: datetime | None = None
    ) -> PayerRefusal | None:
        """Why this user's model work may not start now, or None when it may.

        The safety limit is read as reached once spent meets it; the provider
        chain refuses earlier, by each call's own ceiling (D203's estimate).
        """
        if not metered:
            return None
        payer = self.payer(user_id)
        if payer.installation:
            return None
        if payer.refusal is not None:
            return payer.refusal
        month = self.ledger.month(user_id, now or datetime.now(UTC))
        if month is not None and month.spent_micro_usd >= month.cap_micro_usd:
            return "safety_limit_reached"
        return None
