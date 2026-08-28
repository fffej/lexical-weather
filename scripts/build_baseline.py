#!/usr/bin/env python3
"""Build the compact browser reference from HistWords' eng-all/freqs.pkl.

The input is part of Stanford's HistWords detailed-statistics archive:
https://snap.stanford.edu/historical_embeddings/eng-all.zip

HistWords stores normalized unigram frequencies for each decade. We lowercase and
combine case variants, average the ten decades from 1900 through 1999, retain the most
frequent 50,000 words, and serialize frequencies as occurrences per million.
"""

from __future__ import annotations

import argparse
import json
import math
import pickle
import re
from collections import defaultdict
from pathlib import Path


REFERENCE_DECADES = tuple(range(1900, 2000, 10))
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
        help="Deprecated; accepted for compatibility but no longer embedded",
    )
    return parser.parse_args()


def period_mean(frequencies: dict[int, float], decades: tuple[int, ...]) -> float:
    values = [float(frequencies.get(decade, 0.0)) for decade in decades]
    return sum(value for value in values if math.isfinite(value)) / len(decades)


def main() -> None:
    args = arguments()
    with args.input.open("rb") as source:
        raw = pickle.load(source, encoding="latin1")

    combined: dict[str, float] = defaultdict(float)
    for raw_word, frequencies in raw.items():
        if not isinstance(raw_word, str):
            continue
        word = raw_word.lower().replace("’", "'")
        if not WORD_RE.fullmatch(word):
            continue
        combined[word] += period_mean(frequencies, REFERENCE_DECADES)

    top_words = sorted(
        combined.items(),
        key=lambda item: item[1],
        reverse=True,
    )[: args.limit]

    payload = {
        "meta": {
            "source": "HistWords All English frequencies (Google Books English All)",
            "sourceUrl": "https://nlp.stanford.edu/projects/histwords/",
            "license": "Public Domain Dedication and License 1.0",
            "period": "1900–1999",
            "decades": list(REFERENCE_DECADES),
            "unit": "occurrences per million tokens",
            "aggregation": "lowercased case variants; arithmetic mean of normalized decade frequencies",
            "vocabularySize": len(top_words),
        },
        "words": [
            [word, round(frequency * 1_000_000, 6)]
            for word, frequency in top_words
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as destination:
        json.dump(payload, destination, ensure_ascii=False, separators=(",", ":"))
        destination.write("\n")
    print(f"Wrote {len(top_words):,} words to {args.output}")


if __name__ == "__main__":
    main()
