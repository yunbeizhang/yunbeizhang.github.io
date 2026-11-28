Academic Website of Yunbei Zhang.

https://yunbeizhang.github.io/

## Citation history

`.github/workflows/scholar.yml` runs `scripts/update_scholar.py` twice a day. Each
run makes one SerpAPI author lookup (key in the `SERPAPI_KEY` secret) and saves:

- `assets/scholar.json`: the homepage citation count.
- `assets/scholar-history.json`: one line per check with the profile totals and
  every paper's citation count (keyed by Scholar's citation ID, so renamed
  papers keep their history), plus Scholar's citations-per-year graph.

On the 1st of each month, or when the workflow is run by hand with
"per-paper years" ticked, it also saves each cited paper's citations per year
(one extra search per paper). Twice-daily checks use about 62 of SerpAPI's 250
free searches a month.

`citations/` reads the history file and shows totals, gains and per-paper
changes. Checks before per-paper tracking were recovered from
this repository's commit history and hold totals only.

Preview locally from the site folder:

~~~sh
python3 -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/citations/
~~~

To import a saved SerpAPI author response without making requests:

~~~sh
python3 scripts/update_scholar.py --from-json page1.json [page2.json ...] \
  --at 2026-11-27T18:00:00Z --output-dir /tmp/scholar-import
~~~
