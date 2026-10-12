"""The assistant eval (`data/eval/assistant.json`): its seeded world, its market and its grading.

`scripts/run_assistant_eval.py` is the entry point; these modules are what it
seeds, prices and grades with, kept apart so the hermetic suite can test the
grading and the integration suite can test the world without a model.
"""
