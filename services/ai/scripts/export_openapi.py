"""Dump the FastAPI OpenAPI schema to a file.

The TypeScript client in `packages/shared` is generated from this file, so the
schema is committed and CI can fail when code and client drift apart. No running
server required.

Usage: python scripts/export_openapi.py [output_path]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.main import app

DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "openapi.json"


def main() -> int:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUTPUT
    schema = app.openapi()
    output.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
    print(f"wrote {output} ({len(schema.get('paths', {}))} paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
