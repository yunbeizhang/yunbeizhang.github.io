"""Write Google Scholar citation stats to assets/scholar.json for the homepage."""
import datetime
import json
import os
import sys

from scholarly import scholarly

SCHOLAR_ID = os.environ.get("SCHOLAR_ID", "tVb54uUAAAAJ")
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "scholar.json")

try:
    author = scholarly.fill(scholarly.search_author_id(SCHOLAR_ID), sections=["indices"])
except Exception as err:  # Scholar sometimes rate-limits CI runners; keep the old file.
    print(f"Could not reach Google Scholar: {err}", file=sys.stderr)
    sys.exit(0)

data = {
    "citations": author.get("citedby", 0),
    "h_index": author.get("hindex", 0),
    "i10_index": author.get("i10index", 0),
    "updated": datetime.date.today().isoformat(),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(data, f, indent=2)
print(data)
