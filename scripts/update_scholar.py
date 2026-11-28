"""Record one Google Scholar capture for the homepage and the citation history.

Google Scholar blocks requests from GitHub's servers, so the data comes from
SerpAPI's Google Scholar Author API (key in the SERPAPI_KEY repository secret).
One author lookup gives the profile totals, Scholar's citations-per-year graph
and every paper's citation count. Each run:

* rewrites assets/scholar.json, the number shown beside "Scholar" on the homepage;
* appends a snapshot to assets/scholar-history.json, one line per capture.

With --paper-years it also saves each paper's citations per year from Scholar's
article page. That costs one extra SerpAPI search per cited paper, so the
workflow does it once a month or when run by hand.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from tempfile import NamedTemporaryFile
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

ENDPOINT = "https://serpapi.com/search.json"
PAGE_SIZE = 100
ASSETS = Path(__file__).resolve().parents[1] / "assets"


class CaptureError(ValueError):
    """A response we can't trust. The message never contains the API key."""


def warn(message):
    prefix = "::warning::" if os.environ.get("GITHUB_ACTIONS") else "Warning: "
    print(prefix + message, file=sys.stderr)


def utc_stamp(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise CaptureError("times need a time zone offset")
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def as_count(value):
    """Scholar shows no number for an uncited paper; SerpAPI may send null, "" or a string."""
    if value is None or value == "":
        return 0
    if isinstance(value, str) and value.strip().isdecimal():
        value = int(value)
    if type(value) is not int or value < 0:
        raise CaptureError("invalid citation count")
    return value


def check_page(page, author_id):
    if not isinstance(page, dict):
        raise CaptureError("SerpAPI returned something other than a JSON object")
    if page.get("error"):
        raise CaptureError(f"SerpAPI error: {page['error']}")
    if (page.get("search_metadata") or {}).get("status") not in (None, "Success"):
        raise CaptureError("SerpAPI did not finish the search")
    reported = (page.get("search_parameters") or {}).get("author_id")
    if reported and reported != author_id:
        raise CaptureError("response is for a different Scholar profile")
    return page


def read_profile(first_page, get_page, author_id):
    """Return totals, yearly graph, paper metadata and counts (None if articles were unusable)."""
    cited_by = first_page.get("cited_by") or {}
    stats = {key: value.get("all") for row in cited_by.get("table") or []
             for key, value in row.items() if isinstance(value, dict)}
    totals = {key: stats.get(key) for key in ("citations", "h_index", "i10_index")}
    if not all(type(n) is int and n >= 0 for n in totals.values()):
        raise CaptureError("missing or invalid profile totals")

    yearly = {}
    for row in cited_by.get("graph") or []:
        try:
            yearly[str(int(row["year"]))] = as_count(row.get("citations"))
        except (KeyError, TypeError, ValueError):
            yearly = {}
            warn("Scholar's citations-per-year graph was unreadable; skipped it")
            break

    try:
        papers, counts = read_articles(first_page, get_page, author_id, totals["citations"])
    except CaptureError as error:
        # Keep the profile totals so the homepage still updates; report the gap.
        warn(f"per-paper counts were not saved for this capture: {error}")
        papers, counts = None, None
    return totals, yearly, papers, counts


def read_articles(page, get_page, author_id, total):
    papers, counts, start = {}, {}, 0
    prefix = author_id + ":"
    for _ in range(20):
        articles = page.get("articles")
        if not isinstance(articles, list) or (not articles and (start or total)):
            raise CaptureError("the article list is missing")
        for article in articles:
            citation_id, title = article.get("citation_id"), article.get("title")
            if not isinstance(citation_id, str) or not citation_id.startswith(prefix):
                raise CaptureError("an article has no Scholar citation ID")
            if not isinstance(title, str) or not title.strip():
                raise CaptureError("an article has no title")
            key = citation_id[len(prefix):]
            count = as_count((article.get("cited_by") or {}).get("value"))
            if key in counts:  # the same entry listed twice: keep the larger count
                counts[key] = max(counts[key], count)
                continue
            info = {"title": " ".join(title.split())}
            year = str(article.get("year") or "")
            if len(year) == 4 and year.isdecimal():
                info["year"] = int(year)
            venue = " ".join(str(article.get("publication") or "").split())
            if venue:
                info["venue"] = venue
            papers[key], counts[key] = info, count

        next_link = (page.get("serpapi_pagination") or {}).get("next")
        if not next_link:
            return papers, counts
        query = parse_qs(urlsplit(next_link).query)
        offset = (query.get("cstart") or query.get("start") or [""])[0]
        if not articles or not offset.isdecimal() or int(offset) <= start:
            raise CaptureError("unexpected pagination")
        start = int(offset)
        page = check_page(get_page(start), author_id)
    raise CaptureError("pagination did not finish")


def read_paper_years(get_citation, keys, author_id):
    found = {}
    for key in keys:
        try:
            page = check_page(get_citation(key), author_id)
            table = ((page.get("citation") or {}).get("total_citations") or {}).get("table") or []
            found[key] = {str(int(row["year"])): as_count(row.get("citations")) for row in table}
        except (CaptureError, OSError, KeyError, TypeError, ValueError) as error:
            detail = str(error) if isinstance(error, CaptureError) else type(error).__name__
            warn(f"yearly counts for {key} were skipped: {detail}")
    return found


def load_history(path):
    if not path.exists():
        return {"schema_version": 1, "papers": {}, "snapshots": []}
    history = json.loads(path.read_text(encoding="utf-8"))
    if history.get("schema_version") != 1:
        raise CaptureError("unsupported history format")
    history.setdefault("papers", {})
    for snapshot in history.setdefault("snapshots", []):
        snapshot["at"] = utc_stamp(snapshot["at"])
    return history


def record(history, at, author_id, totals, yearly, papers, counts, paper_years):
    snapshots = history["snapshots"]
    if any(snapshot["at"] == at for snapshot in snapshots):
        raise CaptureError("a capture at this time already exists")
    newest = max((snapshot["at"] for snapshot in snapshots), default="")
    history["author"] = author_id

    newest_papers = max((s["at"] for s in snapshots if "counts" in s), default="")
    for key, info in (papers or {}).items():
        entry = history["papers"].setdefault(key, {})
        if at >= newest_papers:
            entry.update(info)  # newest title and venue win; saved yearly counts stay
        else:
            for field, value in info.items():
                entry.setdefault(field, value)
    for key, years in paper_years.items():
        entry = history["papers"].setdefault(key, {})
        entry["yearly"], entry["yearly_at"] = years, at

    if yearly and at >= history.get("yearly_at", ""):
        history["yearly"], history["yearly_at"] = yearly, at

    snapshot = {"at": at, **totals}
    if counts is not None:
        snapshot["counts"] = counts
    snapshots.append(snapshot)
    snapshots.sort(key=lambda s: s["at"])
    return at >= newest


def history_text(history):
    """Readable header, then one line per capture so each run adds one line to the diff."""
    order = ["schema_version", "author", "yearly_at", "yearly", "papers"]
    head = {key: history[key] for key in order if key in history}
    head |= {key: value for key, value in history.items() if key not in head and key != "snapshots"}
    lines = [json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in history["snapshots"]]
    text = json.dumps(head, ensure_ascii=False, indent=2)[:-2]
    body = ("[\n" + ",\n".join("    " + line for line in lines) + "\n  ]") if lines else "[]"
    return text + ',\n  "snapshots": ' + body + "\n}\n"


def save_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as temp:
        tmp = Path(temp.name)
        try:
            temp.write(text)
            temp.close()
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--paper-years", action="store_true",
                        help="also save each paper's citations per year (one search per paper)")
    parser.add_argument("--from-json", type=Path, nargs="+", metavar="PAGE",
                        help="import saved SerpAPI author response pages instead of making requests")
    parser.add_argument("--at", help="capture time for --from-json, as an ISO time with offset")
    parser.add_argument("--output-dir", type=Path, default=ASSETS)
    args = parser.parse_args()
    author_id = os.environ.get("SCHOLAR_ID", "tVb54uUAAAAJ").strip()
    key = os.environ.get("SERPAPI_KEY", "").strip()

    try:
        if args.from_json:
            if not args.at:
                raise CaptureError("--at is required with --from-json")
            if args.paper_years:
                raise CaptureError("--paper-years needs live requests")
            pages = iter([json.loads(path.read_text(encoding="utf-8")) for path in args.from_json])

            def get_page(start):
                page = next(pages, None)
                if page is None:
                    raise CaptureError("provide every page of the saved response, in order")
                return page

            at = utc_stamp(args.at)
        else:
            if args.at:
                raise CaptureError("--at only applies to --from-json")
            if not key:
                raise CaptureError("the SERPAPI_KEY secret is not set")

            def get_page(start):
                return search(key, author_id=author_id, num=PAGE_SIZE, start=start, sort="title")

            at = utc_stamp(datetime.now(timezone.utc))

        totals, yearly, papers, counts = read_profile(
            check_page(get_page(0), author_id), get_page, author_id)
        paper_years = {}
        if args.paper_years and counts:
            paper_years = read_paper_years(
                lambda paper: search(key, author_id=author_id, view_op="view_citation",
                                     citation_id=f"{author_id}:{paper}"),
                sorted(paper for paper, n in counts.items() if n), author_id)

        history_path = args.output_dir / "scholar-history.json"
        history = load_history(history_path)
        is_newest = record(history, at, author_id, totals, yearly, papers, counts, paper_years)
        save_text(history_path, history_text(history))
        if is_newest:
            save_text(args.output_dir / "scholar.json", json.dumps(
                totals | {"updated": at[:10]}, indent=2) + "\n")
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        # Never print request details: an HTTP error can carry the URL, which has the key.
        detail = str(error) if isinstance(error, CaptureError) else type(error).__name__
        code = getattr(error, "code", None)
        print(f"Scholar update failed: {detail}{f' (HTTP {code})' if code else ''}", file=sys.stderr)
        return 1

    papers_note = f"{len(counts)} papers" if counts is not None else "totals only"
    years_note = f", per-year counts for {len(paper_years)} papers" if paper_years else ""
    print(f"Recorded {at}: {totals['citations']} citations, {papers_note}{years_note}.")
    return 0


def search(key, **params):
    query = urlencode({"engine": "google_scholar_author", "hl": "en", **params, "api_key": key})
    with urlopen(f"{ENDPOINT}?{query}", timeout=60) as response:
        return json.load(response)


if __name__ == "__main__":
    sys.exit(main())
