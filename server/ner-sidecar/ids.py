"""Map PoC corpus ids to Store-style canonical ids.

PoC people use ``pe_…`` (e.g. ``pe_123``, ``pe_dupe_2_1``). The wire contract
requires Store prefixes: ``ct_`` (contact/person seed rows), ``co_`` (company).
Companies in the PoC seed are already ``co_…`` and pass through unchanged.

Mapping (deterministic, reversible for pe_/co_):
  pe_<rest>  →  ct_<rest>
  co_<rest>  →  co_<rest>   (identity)
  ct_<rest>  →  ct_<rest>   (already Store)
  other      →  ct_<sanitized> as a last resort (documented; should not appear)

Never return raw ``pe_`` as ``linkedId`` / candidate ``id``.
"""
from __future__ import annotations

import re

_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")


def to_store_id(poc_id: str, *, entity_type: str | None = None) -> str:
    """Convert a PoC entity id to a Store-style id."""
    if not poc_id:
        raise ValueError("empty entity id")
    if poc_id.startswith("ct_") or poc_id.startswith("ld_") or poc_id.startswith("us_") or poc_id.startswith("tm_"):
        return poc_id
    if poc_id.startswith("co_"):
        return poc_id
    if poc_id.startswith("pe_"):
        return "ct_" + poc_id[3:]
    # Fallback: prefer company prefix when type says so, else contact.
    rest = _SAFE.sub("_", poc_id).strip("_") or "unknown"
    if (entity_type or "").lower() in ("company", "org", "organization"):
        return rest if rest.startswith("co_") else f"co_{rest}"
    return rest if rest.startswith("ct_") else f"ct_{rest}"


def linked_entity_for_label(label: str, poc_role: str | None = None) -> str | None:
    """Optional CRM entity hint for a unique link."""
    label = (label or "").lower()
    if label in ("contact", "lead", "user", "company", "team"):
        return label
    if label == "person":
        role = (poc_role or "").lower()
        if role in ("contact", "lead", "user"):
            return role
        return "contact"
    if label in ("company", "org", "organization"):
        return "company"
    return None
