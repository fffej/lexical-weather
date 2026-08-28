# Lexical Weather

Lexical Weather is a zero-backend live dashboard that shows which words are appearing
unusually often on Bluesky. It keeps a bounded rolling window of public posts in the
browser, calculates word frequencies, and compares them with two twentieth-century
English baselines: 1900–1949 and 1950–1999.

The static site is in [`docs/`](docs/) and is ready for GitHub Pages. It connects directly
to Bluesky's public Jetstream WebSocket; no Bluesky login, application server, database,
or build step is needed.

## Run the dashboard locally

Requirements: Node 22.15 or newer (Node 24 is configured in `.nvmrc`) and Python 3 for
the convenience static server.

```sh
npm install
npm test
npm run build
npm run dashboard
```

Then open <http://localhost:4173>. Opening `docs/index.html` directly will not work
because browsers prevent a `file:` page from fetching the baseline JSON.

## Deploy to GitHub Pages

The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys
`docs/` whenever `main` is pushed. In the repository settings, choose **GitHub Actions**
as the Pages source. A manual run is also available from the Actions tab.

The deployed page is intentionally serverless. Its sliding window exists only in the
open tab, so memory use remains bounded during long runs and refreshing starts a new
sample. On disconnect, the client retries with exponential backoff, alternates between
the east and west public Jetstream instances, and resumes from its last sequence cursor.

## Measurement

- Only `app.bsky.feed.post` create/update/delete events are requested upstream. Updates
  replace their earlier text; deletes and posts leaving the window reverse their counts.
- URL spans are discarded, then text is Unicode-normalized and lowercased.
  Hashtag/mention markers are removed, while apostrophes inside words are retained.
- English-tagged and unlabelled posts are included by default. Explicitly non-English
  posts are skipped because the historical baseline is English.
- The live rate is occurrences per million tokens. Difference is `log2((live ppm + 1) /
  (historical ppm + 1))`; +1 bit is 2× the reference rate and +2 bits is 4×. Ranking
  multiplies positive lift by the square root of live mentions, balancing novelty with
  repeated evidence.
- “New” means missing from the retained 50,000-word historical vocabulary, not proof that
  a word was recently invented. Book English, OCR, corpus composition, social language,
  and author-supplied language labels all introduce bias; the dashboard describes a
  sample, not the whole population.

## Historical baseline

[`docs/data/baseline.json`](docs/data/baseline.json) is derived from the **All English**
per-decade frequency data published by Stanford's
[HistWords project](https://nlp.stanford.edu/projects/histwords/), itself based on the
Google Books English All corpus. The HistWords data is published under the Public Domain
Dedication and License 1.0.

Each period is an arithmetic mean of five normalized decade frequencies:

- 1900–1949: 1900, 1910, 1920, 1930, and 1940
- 1950–1999: 1950, 1960, 1970, 1980, and 1990

Case variants are combined after lowercasing, frequencies are stored as occurrences per
million tokens, and the 50,000 most frequent words across either period are retained.
The sidebar also uses HistWords' `full-nstop_nproper` list to suppress identified
stopwords and proper nouns.

To reproduce the checked-in JSON, obtain `eng-all/freqs.pkl` and
`eng-all/word_lists/full-nstop_nproper.pkl` from the HistWords detailed-statistics
archive, then run:

```sh
python3 scripts/build_baseline.py /path/to/freqs.pkl \
  --filtered-word-list /path/to/full-nstop_nproper.pkl \
  --output docs/data/baseline.json
```

## Topic collector

A small, restart-safe collector for Bluesky's full-network Jetstream. It listens only to
`app.bsky.feed.post` records, matches configured topics in post text, and stores current
matching posts in SQLite.

## Quick start

```sh
cd /home/fffej/code/bluesky
npm install
cp .env.example .env
npm test
npm run build
npm run collect
```

The default topic is `database`. Stop with Ctrl-C; the cursor is committed in the same
SQLite transaction as each post change, so the next run resumes without a gap. Live
Jetstream access is public and needs no Bluesky login.

Useful commands:

```sh
npm run dev                         # restart automatically after source edits
npm run list -- --limit 50          # inspect recent matches
npm run list -- --json              # newline-delimited JSON for scripts
npm run stats                       # post count and stream cursor
npm run collect -- --max-matches 1  # convenient live smoke test
sqlite3 data/posts.sqlite           # query the database directly
```

Set multiple comma-separated fragments in `.env`, for example:

```dotenv
TOPICS=database,postgres,sql server
```

Matching is case-insensitive substring matching, so `database` includes both `database`
and `databases`. Only post text is searched; author profiles and linked-page content are
not.

## Historical replay

Live collection starts at the current network tip. To backfill the archive and then move
seamlessly into live collection, create a Jetstream key at <https://bsky.network/account>,
put it in `.env`, and run:

```sh
npm run collect -- --replay
```

With a new database, replay starts at the beginning of the available archive and can be
very large. On subsequent runs it resumes from the stored cursor. Bluesky meters archive
downloads; live collection remains unmetered.

## Data behavior

The `posts` table is keyed by AT URI, making reconnect delivery idempotent. Post updates
replace the row. Post deletes, account deletes, and repository sync-divergence markers
remove affected content, keeping the database aligned with current network state. The
original decoded record is retained in `raw_record` for later analysis.
