"""The assistant: `/ask` with tools (MEMORY.md, "Planned: the assistant").

A conversation with a model that reads the user's account, the market and this
app through read-only tools, and answers in prose whose every figure is checked
against what those tools returned. It shares the agents' scan loop
(`app/llm/tool_loop.py`) and their read-only tools; what it adds is the
conversation, its own tools, and the check on a prose answer.
"""
