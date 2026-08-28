#!/usr/bin/env python3
"""Build the compact browser baseline from HistWords' eng-all/freqs.pkl.

The input is part of Stanford's HistWords detailed-statistics archive:
https://snap.stanford.edu/historical_embeddings/eng-all.zip

HistWords stores normalized unigram frequencies for each decade. We lowercase and
combine case variants, average five decades into each comparison period, retain the
most frequent 50,000 words, and serialize frequencies as occurrences per million.
"""

from __future__ import annotations

import argparse
import json
import math
import pickle
import re
from collections import defaultdict
from pathlib import Path


EARLY_DECADES = (1900, 1910, 1920, 1930, 1940)
LATE_DECADES = (1950, 1960, 1970, 1980, 1990)
WORD_RE = re.compile(r"^[a-z]+(?:'[a-z]+)*$")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="Path to HistWords eng-all/freqs.pkl")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("docs/data/baseline.json"),
        help="Destination JSON file",
    )
    parser.add_argument("--limit", type=int, default=50_000)
    parser.add_argument(
        "--filtered-word-list",
        type=Path,
        help="Optional HistWords word_lists/full-nstop_nproper.pkl",
    )
    return parser.parse_args()


def period_mean(frequencies: dict[int, float], decades: tuple[int, ...]) -> float:
    values = [float(frequencies.get(decade, 0.0)) for decade in decades]
    return sum(value for value in values if math.isfinite(value)) / len(decades)


def main() -> None:
    args = arguments()
    with args.input.open("rb") as source:
        raw = pickle.load(source, encoding="latin1")

    combined: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    for raw_word, frequencies in raw.items():
        if not isinstance(raw_word, str):
            continue
        word = raw_word.lower().replace("’", "'")
        if not WORD_RE.fullmatch(word):
            continue
        combined[word][0] += period_mean(frequencies, EARLY_DECADES)
        combined[word][1] += period_mean(frequencies, LATE_DECADES)

    top_words = sorted(
        combined.items(),
        key=lambda item: max(item[1]),
        reverse=True,
    )[: args.limit]

    payload = {
        "meta": {
            "source": "HistWords All English frequencies (Google Books English All)",
            "sourceUrl": "https://nlp.stanford.edu/projects/histwords/",
            "license": "Public Domain Dedication and License 1.0",
            "periods": ["1900–1949", "1950–1999"],
            "decades": [list(EARLY_DECADES), list(LATE_DECADES)],
            "unit": "occurrences per million tokens",
            "aggregation": "lowercased case variants; arithmetic mean of normalized decade frequencies",
            "vocabularySize": len(top_words),
        },
        "words": [
            [word, round(periods[0] * 1_000_000, 6), round(periods[1] * 1_000_000, 6)]
            for word, periods in top_words
        ],
    }
    if args.filtered_word_list:
        with args.filtered_word_list.open("rb") as source:
            filtered_words = pickle.load(source, encoding="latin1")
        payload["historicalVocabulary"] = [
            word.lower().replace("’", "'")
            for word in filtered_words
            if isinstance(word, str) and WORD_RE.fullmatch(word.lower().replace("’", "'"))
        ]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as destination:
        json.dump(payload, destination, ensure_ascii=False, separators=(",", ":"))
        destination.write("\n")
    print(f"Wrote {len(top_words):,} words to {args.output}")


if __name__ == "__main__":
    main()
