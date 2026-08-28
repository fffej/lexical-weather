# Streaming Semantic Trend Detection — Algorithm Specification

## 1. Purpose

Detect **new and emerging topics** in a high-volume stream of short text.

A topic is considered interesting when discussion of a coherent subject deviates materially from its historical baseline.

The detector should:

- identify emerging topics without relying on hashtags;
- react quickly to bursts in previously uncommon language;
- combine differently worded messages that refer to the same underlying event;
- suppress permanently high-volume but stable topics;
- operate with bounded memory;
- be suitable for implementation entirely in a browser;
- avoid embedding every incoming message.

This specification covers only the detection algorithm.

---

## 2. High-level algorithm

The detector has two stages:

```text
Incoming text
    │
    ▼
Lexical novelty detector
    │
    │ candidate messages only
    ▼
Semantic embedding
    │
    ▼
Online semantic clustering
    │
    ▼
Topic burst scoring
    │
    ▼
Ranked emerging topics
```

The lexical stage is deliberately cheap and processes every message.

The semantic stage is more expensive and only processes messages that show evidence of lexical novelty.

The fundamental question is:

> What is being discussed significantly more now than would normally be expected?

---

## 3. Definitions

### Message

An individual text item from the stream.

```ts
interface Message {
    id: string;
    text: string;
    timestampMs: number;

    // Optional but strongly recommended for diversity / spam control.
    sourceId?: string;
}
```

### Lexical feature

A normalized unigram or bigram extracted from a message.

Examples:

```text
heathrow
smoke
terminal 5
fire engine
```

### Candidate message

A message whose lexical features contain sufficient evidence of unusual recent activity to justify semantic embedding.

### Topic

A bounded online semantic cluster representing messages with similar meaning.

Example:

```text
"massive smoke near heathrow"
"anyone know what's happening at LHR?"
"fire engines heading towards terminal 5"
```

These should ideally converge on one topic.

---

## 4. Processing stages

Each incoming message passes through the following stages:

1. Normalize text.
2. Extract lexical features.
3. Update short-term and long-term feature statistics.
4. Calculate lexical burst scores.
5. Decide whether the message is a semantic candidate.
6. If selected, generate an embedding.
7. Compare the embedding with active topic centroids.
8. Assign to an existing topic or create a new one.
9. Update topic-level temporal statistics.
10. Calculate topic interestingness.
11. Expire stale features and topics.
12. Rank active topics by interestingness.

---

# 5. Text normalization

Normalization should be intentionally simple. The detector is interested in changes in language, not linguistic correctness.

Recommended steps:

1. Unicode-normalize using `NFKC`.
2. Convert to lowercase.
3. Replace URLs with a fixed token such as `<url>`.
4. Replace user mentions with `<mention>`.
5. Collapse repeated whitespace.
6. Strip punctuation that does not carry useful semantic information.
7. Split into tokens.
8. Remove obvious low-information tokens.
9. Generate unigrams and adjacent bigrams.

Example:

```text
"Massive FIRE near Heathrow!! https://example.com"
```

becomes approximately:

```text
massive
fire
near
heathrow
massive fire
fire near
near heathrow
```

Do not perform aggressive stemming initially.

Do not remove domain-significant words merely because they are common in general English.

---

## 6. Feature filtering

Ignore features that are obviously unsuitable for burst detection.

Examples:

- features shorter than 2 characters;
- pure punctuation;
- pure numeric values unless numbers are semantically important;
- stop words when used as unigrams;
- `<url>` and `<mention>` as standalone features;
- extremely common features that are permanently saturated.

Bigrams containing useful words should still be allowed even if one component is a stop word.

Example:

```text
"fire at"
```

may be less useful than:

```text
"fire heathrow"
```

but this should be decided empirically rather than with an elaborate linguistic pipeline.

---

# 7. Lexical statistics

## 7.1 Required timescales

Maintain multiple estimates of feature activity.

Recommended defaults:

| Statistic | Approximate half-life | Purpose |
|---|---:|---|
| Fast | 60 seconds | Detect immediate bursts |
| Medium | 10 minutes | Confirm sustained emergence |
| Slow | 6 hours | Historical baseline |

Exact fixed windows are not required.

Exponentially decaying statistics avoid retaining all historical messages.

---

## 7.2 Exponential decay

For a stored value `v` last updated at time `t0`, its value at time `t1` is:

\[
v(t_1) = v(t_0) \times 2^{-(t_1-t_0)/h}
\]

where `h` is the half-life.

When a feature occurs, update:

\[
v' = decay(v) + 1
\]

This gives an exponentially weighted count.

Example implementation:

```ts
function decay(
    value: number,
    elapsedMs: number,
    halfLifeMs: number
): number {
    if (value === 0) return 0;

    return value * Math.pow(
        2,
        -elapsedMs / halfLifeMs
    );
}
```

---

## 7.3 Feature state

Logical representation:

```ts
interface FeatureStats {
    fast: number;
    medium: number;
    slow: number;
    lastUpdatedMs: number;
}
```

At large scale, this SHOULD NOT necessarily be implemented as one JavaScript object per feature.

See the bounded-memory section.

---

# 8. Lexical burst score

The purpose of the lexical score is candidate selection, not final trend ranking.

A useful initial formulation is:

\[
burst(f) =
\frac{fastRate(f) + \epsilon}
     {slowRate(f) + \epsilon}
\times evidence(f)
\]

where:

\[
evidence(f) = \log(1 + fastRate(f))
\]

and `epsilon` prevents division by zero.

However, pure ratios over-reward a feature going from essentially zero to one occurrence.

Therefore use a minimum evidence threshold.

Recommended candidate criteria:

```text
fast activity >= MIN_FAST_ACTIVITY
AND
burst score >= MIN_BURST_SCORE
```

Initial defaults:

```ts
const MIN_FAST_ACTIVITY = 3;
const MIN_BURST_SCORE = 3.0;
const EPSILON = 0.25;
```

These values are starting points, not invariants.

---

## 8.1 Alternative significance score

A more statistically interpretable score can be used:

\[
z =
\frac{observed - expected}
     {\sqrt{expected + c}}
\]

where:

- `observed` is recent activity;
- `expected` is activity implied by the slow baseline;
- `c` stabilizes low-volume features.

For implementation, either approach is acceptable.

A practical hybrid is:

\[
lexicalScore =
z \times \log(1 + observed)
\]

The detector SHOULD make the scoring function replaceable.

---

# 9. Candidate message selection

Embedding every message is intentionally avoided.

For each incoming message:

1. extract lexical features;
2. calculate the burst score for each feature;
3. select the highest-scoring features;
4. determine whether the message is a semantic candidate.

Initial rule:

```ts
candidate =
    maxFeatureBurst >= candidateThreshold
    && numberOfBurstingFeatures >= 1;
```

A stronger rule can require either:

```text
one very strong feature
OR
two moderately strong features
```

For example:

```ts
candidate =
    maxScore >= 8
    || scores.filter(x => x >= 3).length >= 2;
```

This avoids embedding every isolated rare word.

---

## 9.1 Candidate suppression

A message SHOULD NOT be embedded if it is effectively a duplicate of a recently embedded message.

A lightweight duplicate signature may be created from normalized tokens.

Possible implementation:

```text
normalized token set
    ↓
64-bit hash / SimHash
    ↓
short-lived recent-signature cache
```

Exact duplicate suppression alone is sufficient for the first implementation.

Recommended duplicate TTL:

```text
2–5 minutes
```

---

# 10. Embeddings

Candidate messages are converted into normalized semantic vectors.

Requirements:

- small local embedding model;
- fixed dimensionality;
- unit-normalized output;
- suitable for short-text semantic similarity.

Represent embeddings using:

```ts
Float32Array
```

If the model does not return normalized embeddings, normalize them:

\[
\hat{x} = \frac{x}{||x||_2}
\]

For normalized vectors:

\[
cosine(a,b) = a \cdot b
\]

Therefore similarity reduces to a dot product.

---

# 11. Online semantic topics

Each active topic is represented by a centroid and bounded metadata.

```ts
interface Topic {
    id: number;

    centroid: Float32Array;

    messageCount: number;

    fastCount: number;
    mediumCount: number;
    slowCount: number;
    lastCountUpdateMs: number;

    createdAtMs: number;
    lastSeenMs: number;

    samples: TopicSample[];

    sourceIds?: Set<string>;
}
```

Representative samples should be bounded.

Example:

```ts
interface TopicSample {
    text: string;
    timestampMs: number;
    similarityToCentroid: number;
}
```

Recommended maximum:

```text
5–10 sample messages per topic
```

---

# 12. Topic assignment

For every candidate embedding:

1. compare it with active topic centroids;
2. find the maximum cosine similarity;
3. assign it to that topic if similarity exceeds a threshold;
4. otherwise create a new topic.

Initial threshold:

```ts
const TOPIC_SIMILARITY_THRESHOLD = 0.72;
```

The correct value depends strongly on the embedding model.

Typical tuning range:

```text
0.65–0.85
```

Pseudo-code:

```ts
function assignTopic(
    embedding: Float32Array,
    activeTopics: Topic[]
): Topic | undefined {
    let bestTopic: Topic | undefined;
    let bestSimilarity = -1;

    for (const topic of activeTopics) {
        const similarity = dot(
            embedding,
            topic.centroid
        );

        if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestTopic = topic;
        }
    }

    if (
        bestTopic &&
        bestSimilarity >= TOPIC_SIMILARITY_THRESHOLD
    ) {
        return bestTopic;
    }

    return undefined;
}
```

Initially, brute-force comparison is preferred over introducing an approximate nearest-neighbour index.

If the active topic count becomes large enough to cause measurable performance problems, replace the lookup implementation without changing the rest of the algorithm.

---

# 13. Updating the topic centroid

When a message joins a topic, update its centroid incrementally.

Simple mean:

\[
c' =
\frac{n c + x}{n+1}
\]

then normalize `c'`.

However, very old messages should eventually stop dominating topic meaning.

An exponentially weighted centroid is therefore preferable:

\[
c' =
normalize((1-\alpha)c + \alpha x)
\]

Recommended starting value:

```ts
const CENTROID_ALPHA = 0.1;
```

This lets a developing event change vocabulary over time while preserving continuity.

---

# 14. Topic temporal statistics

Each topic maintains the same fast / medium / slow temporal estimates as lexical features.

On every assigned candidate:

```text
decay fast
decay medium
decay slow

fast += 1
medium += 1
slow += 1
```

Use topic-specific half-lives or reuse lexical defaults.

Recommended initial values:

```ts
const TOPIC_FAST_HALF_LIFE_MS = 2 * 60_000;
const TOPIC_MEDIUM_HALF_LIFE_MS = 15 * 60_000;
const TOPIC_SLOW_HALF_LIFE_MS = 6 * 60 * 60_000;
```

---

# 15. Topic interestingness

The final ranking SHOULD combine multiple signals.

Conceptually:

\[
I(T) =
Burst(T)
\times Volume(T)
\times Coherence(T)
\times Novelty(T)
\times Diversity(T)
\]

The exact implementation should avoid multiplying raw unbounded values directly.

A weighted additive score is easier to tune:

\[
I(T) =
w_b B(T)
+ w_v V(T)
+ w_c C(T)
+ w_n N(T)
+ w_d D(T)
\]

Recommended starting weights:

```text
burst       0.40
volume      0.20
coherence   0.15
novelty     0.15
diversity   0.10
```

---

# 16. Burst signal

Topic burst answers:

> Is this topic happening much more frequently now than normal?

One implementation:

\[
B(T) =
\log\left(
1 +
\frac{fast(T)+\epsilon}
     {slow(T)+\epsilon}
\right)
\]

A stronger implementation estimates expected fast activity from the slow rate and calculates standardized surprise.

The implementation SHOULD expose this function behind a clear interface:

```ts
function topicBurst(topic: Topic, nowMs: number): number;
```

---

# 17. Volume signal

Burst alone promotes tiny fluctuations.

Volume rewards topics with enough supporting evidence.

Use a saturating function:

\[
V(T) =
\frac{\log(1 + fast(T))}
     {\log(1 + V_{cap})}
\]

clamped to `[0, 1]`.

Example:

```ts
const VOLUME_CAP = 50;
```

Above the cap, additional volume does not materially improve the score.

---

# 18. Semantic coherence

Coherence measures whether messages assigned to a topic actually mean roughly the same thing.

Track the mean similarity of recent messages to the topic centroid.

\[
C(T) =
mean(cosine(x_i, centroid))
\]

Normalize into `[0,1]`.

A topic made of unrelated messages caused by an overly broad lexical burst should therefore rank lower.

Maintain this as an exponentially weighted statistic rather than retaining all embeddings.

```ts
interface Topic {
    // ...
    coherence: number;
}
```

---

# 19. Topic novelty

Novelty answers:

> Is this genuinely a newly emerging topic rather than a continuation of something that has been active for hours?

Possible formulation:

\[
N(T) =
e^{-age(T)/\tau}
\]

but age alone is too aggressive: an old topic can legitimately disappear and re-emerge.

A better signal compares recent semantic activity with its own baseline.

For the first implementation:

```text
high burst + low historical slow activity = high novelty
```

For example:

\[
N(T) =
\frac{1}
     {1 + slow(T)}
\]

after appropriate normalization.

This component can initially be low-weight because much of novelty is already captured by burst.

---

# 20. Source diversity

If `sourceId` is available, a topic SHOULD require evidence from multiple independent sources.

This prevents one account or automated source from creating a trend.

Possible signal:

\[
D(T) =
\min\left(
1,
\frac{uniqueSourcesRecent}{D_{cap}}
\right)
\]

Recommended:

```ts
const SOURCE_DIVERSITY_CAP = 10;
```

The number of remembered source IDs must remain bounded.

A short-lived approximate cardinality structure can replace an exact `Set` if necessary.

If no source identity is available, omit this component and redistribute its weight.

---

# 21. Representative messages

Each topic should retain a small bounded set of representative messages for inspection or later summarization.

Prefer samples that:

1. are close to the centroid;
2. are not duplicates;
3. are reasonably recent;
4. come from different sources when possible.

Do not simply retain the first N messages.

A simple implementation can keep:

```text
- 3 messages closest to centroid
- 2 most recent messages
```

with deduplication.

---

# 22. Topic creation

Create a topic when a candidate embedding is not sufficiently similar to any active topic.

New topic state:

```ts
{
    centroid: embedding,
    messageCount: 1,

    fastCount: 1,
    mediumCount: 1,
    slowCount: 1,

    createdAtMs: now,
    lastSeenMs: now,

    samples: [message]
}
```

A new topic SHOULD NOT immediately be surfaced as interesting.

Recommended minimum:

```ts
const MIN_TOPIC_MESSAGES = 3;
```

and, when source identity exists:

```ts
const MIN_TOPIC_SOURCES = 2;
```

---

# 23. Topic expiry

Topics must be bounded in number.

A topic can be deleted when all of the following are true:

```text
last seen > stale TTL
AND
fast activity is negligible
AND
medium activity is negligible
```

Recommended starting TTL:

```ts
const TOPIC_STALE_TTL_MS = 60 * 60_000;
```

Long-running topics are retained while active.

A hard maximum topic count SHOULD also exist.

Example:

```ts
const MAX_ACTIVE_TOPICS = 2000;
```

If exceeded:

1. remove stale topics;
2. remove topics with the lowest activity;
3. remove topics with the lowest interestingness.

---

# 24. Feature storage and bounded memory

A naïve implementation using:

```ts
Map<string, FeatureStats>
```

may allocate too much memory under a large stream.

Two implementation modes are recommended.

---

## 24.1 Prototype mode

Use:

```ts
Map<string, FeatureStats>
```

Advantages:

- easy to inspect;
- easy to debug;
- exact feature identity;
- straightforward implementation.

Use this first unless measurements prove it inadequate.

Periodically remove features whose decayed activity is below a small threshold.

Example:

```ts
if (
    stats.fast < 0.01 &&
    stats.medium < 0.01 &&
    stats.slow < 0.01
) {
    features.delete(feature);
}
```

---

## 24.2 High-volume mode

Hash features into fixed-size TypedArrays.

Example:

```ts
const BUCKETS = 1 << 20;

const fast = new Float32Array(BUCKETS);
const medium = new Float32Array(BUCKETS);
const slow = new Float32Array(BUCKETS);
const lastUpdated = new Float64Array(BUCKETS);
```

Feature:

```text
hash(feature) & (BUCKETS - 1)
```

This produces fixed memory usage at the cost of hash collisions.

A Count-Min Sketch may also be used if collision bias becomes important.

The algorithm MUST tolerate approximate lexical counts because lexical statistics are only a candidate filter.

Semantic clustering is responsible for higher-quality confirmation.

---

# 25. Co-occurrence signal

A useful enhancement is detecting combinations of lexical features that become unusual together.

Example:

```text
heathrow
smoke
fire
terminal
```

Each individual word may be only moderately interesting, while their co-occurrence strongly indicates an event.

For every candidate message:

1. take its top `K` bursty lexical features;
2. generate bounded feature pairs;
3. maintain burst statistics for these pairs.

Recommended:

```ts
const MAX_COOCCURRENCE_FEATURES = 5;
```

This creates at most:

\[
{5 \choose 2} = 10
\]

pairs per message.

Co-occurrence should be treated as an additional lexical candidate signal.

It is not required for the initial implementation.

---

# 26. Spam and duplication resistance

The detector should avoid interpreting repetition as discovery.

Recommended controls:

### Exact text deduplication

Ignore repeated normalized text within a short TTL.

### Source throttling

A single `sourceId` should contribute at most a bounded amount to a topic over a short interval.

Example:

```text
maximum 3 contributions per source per topic per minute
```

### Near-duplicate suppression

Optional later enhancement using SimHash or embedding similarity.

### Diversity requirement

Do not surface a high-confidence topic until multiple independent sources contribute.

---

# 27. Event loop

Conceptual message-processing algorithm:

```ts
async function processMessage(message: Message) {
    const normalized = normalize(message.text);

    if (!normalized) return;
    if (isRecentDuplicate(normalized)) return;

    const features = extractFeatures(normalized);

    const burstScores: number[] = [];

    for (const feature of features) {
        const stats = updateFeatureStats(
            feature,
            message.timestampMs
        );

        burstScores.push(
            lexicalBurst(stats, message.timestampMs)
        );
    }

    if (!isCandidate(burstScores)) {
        return;
    }

    const embedding = await embed(normalized);

    let topic = findMatchingTopic(embedding);

    if (!topic) {
        topic = createTopic(
            embedding,
            message
        );
    } else {
        updateTopic(
            topic,
            embedding,
            message
        );
    }

    topic.interestingness =
        scoreTopic(topic, message.timestampMs);
}
```

---

# 28. Periodic maintenance

Maintenance should occur periodically rather than on every message.

Recommended interval:

```text
5–30 seconds
```

Maintenance tasks:

```ts
function maintain(nowMs: number) {
    expireDuplicateSignatures(nowMs);

    pruneInactiveFeatures(nowMs);

    expireStaleTopics(nowMs);

    if (activeTopics.length > MAX_ACTIVE_TOPICS) {
        pruneLowestValueTopics();
    }

    recomputeTopTopics(nowMs);
}
```

Decay does not need to be eagerly applied to every stored counter.

Values can be lazily decayed when read or updated.

This is important for performance.

---

# 29. Ranking

Only topics meeting minimum evidence requirements should be ranked.

Example eligibility:

```ts
eligible =
    topic.messageCount >= MIN_TOPIC_MESSAGES
    && topic.fastCount >= MIN_TOPIC_FAST_ACTIVITY
    && (
        !sourceIdsAvailable
        || uniqueRecentSources >= MIN_TOPIC_SOURCES
    );
```

Return the top `N` topics ordered by descending interestingness.

Recommended:

```ts
const MAX_VISIBLE_TOPICS = 20;
```

The ranking layer should expose:

```ts
interface RankedTopic {
    topicId: number;
    score: number;

    burst: number;
    volume: number;
    coherence: number;
    novelty: number;
    diversity?: number;

    samples: string[];
}
```

Keeping component scores visible is important for tuning and diagnostics.

---

# 30. Emerging vs established topics

The detector should distinguish between:

```text
EMERGING
ACTIVE
FADING
```

Suggested interpretation:

### EMERGING

```text
fast >> slow
and fast increasing
```

### ACTIVE

```text
fast approximately consistent with medium
and volume remains high
```

### FADING

```text
fast < medium
and medium remains above slow
```

This classification is useful because the highest-volume topic is not necessarily the most interesting topic.

The primary ranking should favour `EMERGING`.

---

# 31. Acceleration

Optional enhancement:

Maintain two short timescales:

```text
veryFast: 30 second half-life
fast:     2 minute half-life
```

Then:

\[
acceleration =
\frac{veryFast + \epsilon}
     {fast + \epsilon}
\]

This distinguishes:

```text
1, 2, 5, 14, 38
```

from:

```text
10, 10, 10, 10, 10
```

Acceleration can be added as another ranking component once the base detector works.

---

# 32. Recommended initial constants

These values provide a reasonable implementation starting point.

```ts
export const TrendDetectionDefaults = {
    lexicalFastHalfLifeMs: 60_000,
    lexicalMediumHalfLifeMs: 10 * 60_000,
    lexicalSlowHalfLifeMs: 6 * 60 * 60_000,

    lexicalMinFastActivity: 3,
    lexicalMinBurstScore: 3,
    lexicalStrongBurstScore: 8,

    topicFastHalfLifeMs: 2 * 60_000,
    topicMediumHalfLifeMs: 15 * 60_000,
    topicSlowHalfLifeMs: 6 * 60 * 60_000,

    topicSimilarityThreshold: 0.72,
    centroidAlpha: 0.1,

    minTopicMessages: 3,
    minTopicSources: 2,

    topicStaleTtlMs: 60 * 60_000,
    maxActiveTopics: 2000,

    maxTopicSamples: 5,

    duplicateTtlMs: 3 * 60_000,

    sourceDiversityCap: 10,
    volumeCap: 50,

    scoreWeights: {
        burst: 0.40,
        volume: 0.20,
        coherence: 0.15,
        novelty: 0.15,
        diversity: 0.10,
    },
} as const;
```

These constants MUST be configurable.

---

# 33. Threading model

The algorithm naturally separates into workers.

Recommended decomposition:

```text
Main thread
    │
    │ messages
    ▼
Lexical Worker
    │
    │ candidates
    ▼
Embedding Worker
    │
    │ vectors
    ▼
Topic Worker
```

A simpler initial implementation may combine lexical and topic logic into one worker.

The expensive embedding operation SHOULD NOT execute on the main UI thread.

Messages crossing worker boundaries should be small.

Transfer `ArrayBuffer`s rather than copying embeddings where possible.

---

# 34. Performance characteristics

For every incoming message, lexical processing should be approximately:

\[
O(numberOfTokens)
\]

Candidate semantic processing is:

\[
O(numberOfActiveTopics \times embeddingDimensions)
\]

when using brute-force centroid comparison.

This is acceptable while:

```text
candidate rate << input rate
```

and active topic count remains bounded.

The critical performance objective is therefore:

> Keep the semantic candidate rate low without suppressing genuinely emerging topics.

Candidate rate should be measured continuously.

A useful target for initial tuning is:

```text
0.1%–2% of messages embedded
```

depending on stream characteristics.

---

# 35. Metrics required for tuning

The implementation SHOULD expose internal diagnostics.

At minimum:

```text
messages processed / second
candidate messages / second
candidate percentage
active lexical features
active topics
embeddings / second
topic assignments / second
new topics / second
duplicate suppression rate
topic expiry rate
```

For each surfaced topic expose:

```text
interestingness
burst score
volume score
coherence score
novelty score
source diversity
message count
age
recent samples
```

Without these values it will be difficult to understand false positives and false negatives.

---

# 36. Expected behaviour

## Stable high-volume topic

Historical:

```text
500 messages/minute
```

Current:

```text
520 messages/minute
```

Expected result:

```text
low burst
high volume
low interestingness
```

---

## Sudden new event

Historical:

```text
~0 messages/minute
```

Current:

```text
30 related messages/minute
```

Expected result:

```text
very high burst
moderate volume
high semantic coherence
high novelty
high interestingness
```

---

## Single strange message

Historical:

```text
0
```

Current:

```text
1
```

Expected result:

```text
high raw ratio
insufficient evidence
not surfaced
```

---

## Spam repetition

Current:

```text
100 identical messages from one source
```

Expected result:

```text
duplicate/source suppression
low diversity
not surfaced
```

---

## Differently worded reports of same event

Messages:

```text
"huge plume of smoke near Heathrow"

"what has happened at LHR?"

"loads of fire engines heading to terminal five"

"something burning by Heathrow airport"
```

Expected result:

```text
lexically unusual messages become candidates
embeddings map messages to same topic
topic count rapidly increases
topic appears as emerging
```

---

# 37. Implementation order

Implement incrementally.

## Phase 1 — lexical detector

Implement:

- normalization;
- unigrams;
- bigrams;
- fast/medium/slow counters;
- lexical burst scoring;
- candidate selection;
- diagnostics.

Validate that emerging terms are detected.

Do not implement embeddings yet.

---

## Phase 2 — semantic clustering

Add:

- embedding worker;
- normalized vectors;
- topic centroids;
- brute-force topic matching;
- topic creation;
- topic expiry.

Validate that differently worded messages about one event converge.

---

## Phase 3 — topic ranking

Add:

- topic burst;
- volume;
- coherence;
- novelty;
- combined interestingness;
- minimum evidence thresholds.

Validate ranking against recorded streams.

---

## Phase 4 — robustness

Add:

- duplicate suppression;
- source diversity;
- source throttling;
- representative samples;
- co-occurrence detection.

---

## Phase 5 — optimization

Only if profiling requires it:

- hashed lexical counters;
- Count-Min Sketch;
- approximate topic nearest-neighbour search;
- quantized embeddings;
- more aggressive candidate filtering.

Do not introduce these optimizations before measurements justify them.

---

# 38. Testing strategy

The detector should be testable against deterministic synthetic streams.

## Test 1 — baseline stability

Generate a stable distribution of topics for several simulated hours.

Expected:

```text
no persistent false trends
```

---

## Test 2 — sudden lexical burst

Inject a previously rare phrase at increasing frequency.

Expected:

```text
candidate threshold crossed quickly
```

---

## Test 3 — semantic paraphrases

Inject semantically equivalent messages with little lexical overlap.

Expected:

```text
messages converge into one topic
```

---

## Test 4 — high-volume background

Maintain a permanently common topic while introducing a much smaller novel topic.

Expected:

```text
novel topic ranks above stable high-volume topic
```

---

## Test 5 — one-message anomaly

Inject a unique phrase once.

Expected:

```text
not surfaced
```

---

## Test 6 — spam burst

Inject many duplicate messages from one source.

Expected:

```text
not surfaced as a high-confidence trend
```

---

## Test 7 — topic fade

Create a burst and then stop generating matching messages.

Expected:

```text
EMERGING → ACTIVE/FADING → expired
```

---

# 39. Design principles

The implementation should preserve the following properties.

### Bounded memory

No algorithmic component may require retaining the complete stream.

### Cheap common path

The overwhelming majority of messages should only execute lexical processing.

### Lazy decay

Do not periodically update every stored counter solely to apply time decay.

### Approximation is acceptable

The lexical stage is a filter. Exact global statistics are unnecessary.

### Semantic confirmation

Embedding similarity should resolve paraphrases and lexical fragmentation.

### Relative, not absolute popularity

A topic is interesting because its behaviour changed relative to its baseline.

### Explainable scores

Keep individual scoring components observable rather than producing one opaque number.

### Measure before optimizing

Begin with ordinary `Map`s and brute-force centroid search. Replace them only when profiling demonstrates a bottleneck.

---

# 40. Core invariant

The detector is not trying to answer:

> What are people talking about?

It is trying to answer:

> What are people talking about **more than would normally be expected, right now**, and are those messages semantically describing the same thing?

Everything in the algorithm should support that distinction.
