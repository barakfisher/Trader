"""LLM access layer.

Deliberately empty of re-exports. `app.config` imports `app.llm.pricing` to
parse the price table at boot, and importing any submodule executes this file -
so a convenience re-export of the factory here would make `app.config` import
the factory, which imports `app.config`. Callers import the module they need.
"""
