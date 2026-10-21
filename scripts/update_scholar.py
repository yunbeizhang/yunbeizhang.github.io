"""Write Google Scholar citation stats to assets/scholar.json for the homepage.

Google Scholar blocks requests from GitHub's servers, so the numbers come from
SerpApi's Google Scholar Author API (key in the SERPAPI_KEY repository secret).
If anything goes wrong the script exits with an error, so the workflow run shows
as failed (and GitHub emails you) instead of silently keeping an old number.
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

SCHOLAR_ID = os.environ.get("SCHOLAR_ID", "tVb54uUAAAAJ")
API_KEY = os.environ.get("SERPAPI_KEY", "").strip()
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "scholar.json")


def fail(msg):
    print(f"Scholar update failed: {msg}", file=sys.stderr)
    sys.exit(1)


if not API_KEY:
    fail("the SERPAPI_KEY secret is not set")

query = urllib.parse.urlencode({
    "engine": "google_scholar_author",
    "author_id": SCHOLAR_ID,
    "hl": "en",
    "api_key": API_KEY,
})
try:
    with urllib.request.urlopen("https://serpapi.com/search.json?" + query, timeout=60) as r:
        res = json.load(r)
except Exception as err:  # never print the URL: it contains the key
    fail(f"could not reach SerpApi ({type(err).__name__}: {getattr(err, 'code', '')})")

if res.get("error"):
    fail(res["error"])

# cited_by.table = [{"citations": {"all": N, ...}}, {"h_index": {...}}, {"i10_index": {...}}]
table = {k: v.get("all") for row in res.get("cited_by", {}).get("table", []) for k, v in row.items()}
data = {
    "citations": table.get("citations"),
    "h_index": table.get("h_index"),
    "i10_index": table.get("i10_index"),
    "updated": datetime.date.today().isoformat(),
}
if not all(isinstance(data[k], int) and data[k] > 0 for k in ("citations", "h_index", "i10_index")):
    fail(f"unexpected response: {table}")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(data)
