import assert from "node:assert/strict";
import {
  ATTRIBUTION_NOTE,
  buildChangePointCard,
  CHANGE_POINT_HIGHLIGHT_LIMIT,
  describeDelivery,
  extraSuspects,
  formatChangePointLine,
  formatStandingLine,
  freshStanding,
  isColdStart,
  isRegression,
  rankChangePoints,
  reportedFactor,
  SEVERE_CHANGE_POINT_RATIO,
  STANDING_LIMIT,
  STANDING_CONTRAST,
  STANDING_NOTE,
  seenAfterCard,
  standingDurationText,
  standingKey,
  summariseChangePoints,
} from "./change-point-card-model.mjs";

// One confirmed change point, as `run-shadow-analysis.mjs` writes it.
const pointOf = ({
  caseId = "record-read/case",
  ratio = 1.5,
  pValue = 0.001,
  mover = "v2",
  before = 400,
  after = 600,
  beforeCommit = "aaaaaaaa11111111",
  afterCommit = "bbbbbbbb22222222",
  alsoPossible,
  unmeasuredBetween = 0,
} = {}) => ({
  caseId,
  ratio,
  pValue,
  mover,
  beforeCommit,
  afterCommit,
  alsoPossible: alsoPossible ?? [beforeCommit, afterCommit],
  unmeasuredBetween,
  ...(before === undefined || after === undefined
    ? {}
    : { v2Level: { before, after } }),
});

const resultOf = ({ confirmed = [], seenBefore = 200 } = {}) => ({
  runId: "31627348576",
  teableEeRef: "9c36d27d103dd9003c3ef774e9cf6922276beedd",
  confirmed,
  seenBefore,
});

const context = {
  chartUrl: "https://ppm.teable.app",
  runUrl: "https://github.com/teableio/teable-perf-lab/actions/runs/1",
  teableResultsUrl: "https://app.teable.ai/base/x/table/y/view/z",
  teableRef: "9c36d27d103dd9003c3ef774e9cf6922276beedd",
};

const cardText = (card) =>
  JSON.stringify(card).replace(/\\n/g, "\n").replace(/\\"/g, '"');

// --- what counts as a regression ---------------------------------------------

// The direction that puts a row on the card is the paired ratio rising *and*
// V2's own level rising with it.
assert.equal(
  isRegression(pointOf({ ratio: 1.5, before: 400, after: 600 })),
  true,
);
assert.equal(
  isRegression(pointOf({ ratio: 0.7, before: 600, after: 400 })),
  false,
);

// The case that made this a function rather than `ratio > 1`. On record it is
// `record-create/mixed-1k-20fields-bulk-create`: the pair reads 1.28x while V2
// went 1231ms to 627ms, because V1 got faster still. A card calling that a
// regression sends someone to look for a slowdown that is a speedup.
assert.equal(
  isRegression(pointOf({ ratio: 1.28, before: 1231, after: 627 })),
  false,
);

// No levels to check against — records written before attribution existed. Kept
// on the ratio alone rather than dropped, so the list does not silently shrink.
assert.equal(
  isRegression(pointOf({ ratio: 1.4, before: undefined, after: undefined })),
  true,
);

assert.equal(isRegression(pointOf({ ratio: Number.NaN })), false);
assert.equal(isRegression(undefined), false);

// --- which rows the card lists ------------------------------------------------

// `v1` is a real change point and never a row: the levels printed are V2's and
// the ratio is the pair's, and on a v1 row they disagree past reading together.
{
  const ranked = rankChangePoints([
    pointOf({
      caseId: "v1-mover",
      ratio: 2.2,
      mover: "v1",
      before: 37,
      after: 40,
    }),
    pointOf({ caseId: "v2-mover", ratio: 1.2, mover: "v2" }),
  ]);
  assert.deepEqual(
    ranked.map((point) => point.caseId),
    ["v2-mover"],
  );
}

// Worst first, and "worst" is what the row says — V2's own movement — not the
// paired ratio the row never prints. These three carry paired ratios in the
// opposite order to their V2 levels, so a rank on `ratio` fails here.
{
  const ranked = rankChangePoints([
    pointOf({ caseId: "small", ratio: 3.6, before: 400, after: 480 }),
    pointOf({ caseId: "big", ratio: 1.2, before: 400, after: 1600 }),
    pointOf({ caseId: "middle", ratio: 2.0, before: 400, after: 800 }),
  ]);
  assert.deepEqual(
    ranked.map((point) => point.caseId),
    ["big", "middle", "small"],
  );
}

// --- the three buckets sum to the total --------------------------------------

// The card states all three, so a reader can check its arithmetic against the
// artifact. They are defined to add up; this is what holds them to it.
{
  const confirmed = [
    pointOf({ caseId: "slower", ratio: 1.9 }),
    pointOf({ caseId: "faster", ratio: 0.6, before: 900, after: 500 }),
    pointOf({
      caseId: "control",
      ratio: 2.2,
      mover: "v1",
      before: 37,
      after: 40,
    }),
    pointOf({
      caseId: "v1-sped-up",
      ratio: 1.3,
      mover: "v2",
      before: 1231,
      after: 627,
    }),
  ];
  const summary = summariseChangePoints(confirmed);
  assert.equal(summary.total, 4);
  assert.equal(summary.regressions.length, 1);
  // Two faster, because the buckets count what the card would print. Counting
  // on the paired ratio put `v1-sped-up` — V2 went 1231ms to 627ms — in the
  // leftover bucket, where a case that halved was reported as neither faster
  // nor slower.
  assert.equal(summary.faster, 2);
  assert.equal(summary.unchanged, 1);
  assert.equal(
    summary.regressions.length + summary.faster + summary.unchanged,
    summary.total,
  );
}

// --- the row --------------------------------------------------------------

{
  const line = formatChangePointLine(
    pointOf({
      caseId: "record-read/10k-filter",
      ratio: 1.93,
      pValue: 0.0008,
      before: 613,
      after: 1216,
      beforeCommit: "9aac6f6f0000000000",
      afterCommit: "c6e24ab40000000000",
    }),
    "https://ppm.teable.app",
  );
  assert.match(line, /record-read\/10k-filter/);
  assert.match(line, /https:\/\/ppm\.teable\.app#record-read\/10k-filter/);
  assert.match(line, /0\.61s → 1\.22s/);
  // 1216/613, not the 1.93 paired ratio. A reader who divides the two printed
  // numbers has to land on the printed factor, or the row argues with itself.
  assert.equal(
    reportedFactor(pointOf({ before: 613, after: 1216 })),
    1216 / 613,
  );
  assert.match(line, /慢2\.0x/);
  assert.match(line, /p=0\.0008/);
  // Nothing about V1 reaches the reader. It is the detector's ruler and the
  // card is not about it.
  assert.doesNotMatch(line, /V1|对照/);
  assert.match(line, /引入于 `9aac6f6f`→`c6e24ab4`/);
}

// `alsoPossible` normally repeats the boundary's own two commits, and a line
// naming them twice adds no fact.
assert.equal(
  extraSuspects(pointOf({ beforeCommit: "aaaa1111", afterCommit: "bbbb2222" }))
    .length,
  0,
);
assert.deepEqual(
  extraSuspects(
    pointOf({
      beforeCommit: "aaaa1111",
      afterCommit: "bbbb2222",
      alsoPossible: ["aaaa1111", "cccc3333"],
    }),
  ),
  ["cccc3333"],
);
assert.match(
  formatChangePointLine(
    pointOf({ alsoPossible: ["aaaaaaaa11111111", "cccccccc33333333"] }),
    "",
  ),
  /同样可疑 `cccccccc`/,
);

// The number that says the named commit ends a range rather than answering the
// question. Silent when zero; a "0 个未测" on every row is noise.
assert.doesNotMatch(formatChangePointLine(pointOf(), ""), /未测/);
assert.match(
  formatChangePointLine(pointOf({ unmeasuredBetween: 252 }), ""),
  /区间内 252 个 commit 未测/,
);

// A record with no levels prints the ratio alone rather than an empty arrow,
// which would read as missing data instead of a record from before levels.
assert.doesNotMatch(
  formatChangePointLine(pointOf({ before: undefined, after: undefined }), ""),
  /→ *·/,
);

// --- when a card is sent ------------------------------------------------------

// Nothing confirmed, nothing pushed — and the reason is stated either way, so a
// quiet night is distinguishable from a broken step.
{
  const decision = describeDelivery({ result: resultOf() });
  assert.equal(decision.send, false);
  assert.match(decision.reason, /no new confirmed change points/);
  assert.equal(
    buildChangePointCard({ result: resultOf(), context }),
    undefined,
  );
}

// Change points, none of them a V2 slowdown. Still no card: there is nothing to
// open. The counts go in the log line so the silence is accountable.
{
  const result = resultOf({
    confirmed: [pointOf({ ratio: 0.6, before: 900, after: 500 })],
  });
  const decision = describeDelivery({ result });
  assert.equal(decision.send, false);
  assert.match(decision.reason, /1 new change point,/);
  assert.match(decision.reason, /none of them a slowdown/);
  assert.equal(buildChangePointCard({ result, context }), undefined);
}

// The cold start. On 2026-08-09 a silent cache miss left the seen-set empty and
// the run re-reported 117 change points, 25 of them slowdowns already announced
// days earlier. Pushing that is the repeating alert the seen-set exists to
// prevent.
{
  const result = resultOf({
    confirmed: Array.from({ length: 25 }, (_, index) =>
      pointOf({ caseId: `case-${index}`, ratio: 1.9 }),
    ),
    seenBefore: 0,
  });
  assert.equal(isColdStart(result), true);
  const decision = describeDelivery({ result });
  assert.equal(decision.send, false);
  assert.match(decision.reason, /cold start/);
  assert.match(decision.reason, /25 of them slowdowns/);
  assert.equal(buildChangePointCard({ result, context }), undefined);
}

// --- the card itself ---------------------------------------------------------

{
  const result = resultOf({
    confirmed: [
      pointOf({ caseId: "slow/one", ratio: 2.3 }),
      pointOf({ caseId: "slow/two", ratio: 1.4 }),
      pointOf({ caseId: "fast/one", ratio: 0.5, before: 900, after: 400 }),
    ],
  });
  const decision = describeDelivery({ result });
  assert.equal(decision.send, true);

  const card = buildChangePointCard({ result, context });
  const text = cardText(card);

  assert.equal(card.msg_type, "interactive");
  // Red only when something reached the severe factor, so the colour carries a
  // fact rather than marking every card the same.
  assert.equal(card.card.header.template, "red");
  assert.match(card.card.header.title.content, /变更点 · 新确认变慢 2/);

  // The three counts, and the sentence that keeps a reader from reading a
  // change point as tonight's build.
  assert.match(text, /新确认变慢 2/);
  assert.match(text, /其中 1 个达到 2x/);
  assert.match(text, /本轮共确认 3 个变更点，另外 1 个变快，不在下面/);
  assert.match(text, /可能比本轮测的 `9c36d27d` 早很多/);

  // Owed to triage since the ±1 tolerance was signed off, and delivered
  // nowhere a person reads until this card.
  assert.ok(text.includes(ATTRIBUTION_NOTE));

  assert.match(text, /slow\/one/);
  assert.match(text, /slow\/two/);
  assert.doesNotMatch(text, /fast\/one/);

  // Forwarded on its own, a card is all the reader gets.
  const buttons = card.card.elements.at(-1);
  assert.equal(buttons.tag, "action");
  assert.deepEqual(
    buttons.actions.map((action) => action.url),
    [context.runUrl, context.teableResultsUrl, context.chartUrl],
  );
}

// Orange when nothing reached the severe factor.
{
  const card = buildChangePointCard({
    result: resultOf({ confirmed: [pointOf({ ratio: 1.3 })] }),
    context,
  });
  assert.equal(card.card.header.template, "orange");
  assert.doesNotMatch(cardText(card), /达到 2x/);
}

// Exactly at the bar counts as severe; the card says "达到", not "超过".
{
  const card = buildChangePointCard({
    result: resultOf({
      confirmed: [pointOf({ ratio: SEVERE_CHANGE_POINT_RATIO })],
    }),
    context,
  });
  assert.equal(card.card.header.template, "red");
}

// Past the limit the rest fold away rather than being dropped. The cold-start
// run is the one that produces a list this long, and it no longer pushes — but
// the bound is what stops a card from being a wall either way.
{
  const confirmed = Array.from(
    { length: CHANGE_POINT_HIGHLIGHT_LIMIT + 3 },
    (_, index) =>
      pointOf({ caseId: `case-${index}`, ratio: 1.9 - index * 0.05 }),
  );
  const card = buildChangePointCard({
    result: resultOf({ confirmed }),
    context,
  });
  const panel = card.card.elements.find(
    (element) => element.tag === "collapsible_panel",
  );
  assert.match(panel.header.title.content, /其余 3/);
  const text = cardText(card);
  for (const point of confirmed) {
    assert.match(text, new RegExp(point.caseId));
  }
}

// --- the standing section ------------------------------------------------------

const standingOf = (
  caseId,
  controlledDrift,
  { then = 400, now = 900 } = {},
) => ({
  caseId,
  controlledDrift,
  v2Drift: now / then,
  v2Then: then,
  v2Now: now,
  points: 240,
});

// A case joining the list is news; the list repeating is not. The key is
// namespaced so it cannot collide with a change point's `case@before..after`.
{
  const rows = [standingOf("a", 2.1), standingOf("b", 1.4)];
  assert.equal(standingKey(rows[0]), "standing:a");
  assert.deepEqual(
    freshStanding(rows, ["standing:a"]).map((row) => row.caseId),
    ["b"],
  );
  assert.equal(freshStanding(rows, ["standing:a", "standing:b"]).length, 0);
}

// No new change point, but a case has just arrived on the standing list. This
// is the path that reaches `record-read/10k-50fields-group-three-levels`: the
// measurability screen keeps it out of detection entirely, so no change point
// will ever announce it, and only this can.
{
  const result = { ...resultOf(), standing: [standingOf("newly-slow", 2.8)] };
  const decision = describeDelivery({ result, seen: [] });
  assert.equal(decision.send, true);
  assert.match(decision.reason, /newly standing/);
  const card = buildChangePointCard({ result, context, seen: [] });
  assert.ok(card, "a newly standing case is worth a card on its own");
  const text = cardText(card);
  assert.match(text, /newly-slow/);
  // No change point section, so nothing that describes one: no empty row block,
  // no attribution note, and no sentence pointing at "上面".
  assert.doesNotMatch(text, /本轮共确认/);
  assert.ok(!text.includes(ATTRIBUTION_NOTE));
  assert.ok(!text.includes(STANDING_CONTRAST));
  assert.match(card.card.header.title.content, /性能未恢复 1/);
}

// The same list a day later, with nothing new, is not a card.
{
  const result = { ...resultOf(), standing: [standingOf("newly-slow", 2.8)] };
  const decision = describeDelivery({
    result,
    seen: ["standing:newly-slow"],
  });
  assert.equal(decision.send, false);
  assert.equal(
    buildChangePointCard({ result, context, seen: ["standing:newly-slow"] }),
    undefined,
  );
}

// When the card does go out for a change point, it carries the standing list
// too — that is the whole reason the two share a card.
{
  const result = {
    ...resultOf({ confirmed: [pointOf({ caseId: "moved", ratio: 1.9 })] }),
    standing: [standingOf("still-slow", 2.1), standingOf("also-slow", 1.4)],
  };
  const card = buildChangePointCard({
    result,
    context,
    seen: ["standing:still-slow", "standing:also-slow"],
  });
  const text = cardText(card);
  assert.match(card.card.header.title.content, /未恢复 2/);
  assert.match(text, /still-slow/);
  assert.ok(text.includes(STANDING_NOTE));
  // The contrast sentence needs a section above it to contrast with.
  assert.ok(text.includes(STANDING_CONTRAST));
  // Worst first, and the row prints where it was against where it is.
  assert.match(
    formatStandingLine(standingOf("x", 2.1, { then: 400, now: 900 }), ""),
    /0\.40s → 0\.90s/,
  );
}

// One unit for both ends, chosen by the smaller one. Seconds at two decimals
// cannot show a move the smaller end is sensitive to: 82ms → 105ms is a real
// 1.3x that rendered as `0.08s → 0.10s`.
{
  assert.match(
    formatStandingLine(standingOf("x", 1.3, { then: 82, now: 105 }), ""),
    /82ms → 105ms/,
  );
  // And the defect this rule was written for in the first place: one end in
  // milliseconds and the other in seconds.
  assert.match(
    formatStandingLine(standingOf("x", 2.4, { then: 56, now: 146 }), ""),
    /56ms → 146ms/,
  );
}

// Past the limit the rest fold away rather than being dropped.
{
  const standing = Array.from({ length: STANDING_LIMIT + 4 }, (_, index) =>
    standingOf(`case-${index}`, 2 - index * 0.05),
  );
  const result = {
    ...resultOf({ confirmed: [pointOf({ caseId: "moved", ratio: 1.9 })] }),
    standing,
  };
  const text = cardText(
    buildChangePointCard({
      result,
      context,
      seen: standing.map((row) => standingKey(row)),
    }),
  );
  for (const row of standing) {
    assert.match(text, new RegExp(row.caseId));
  }
}

// A run with no standing list at all renders without the section rather than
// with an empty one.
{
  const card = buildChangePointCard({
    result: resultOf({ confirmed: [pointOf({ ratio: 1.9 })] }),
    context,
  });
  assert.doesNotMatch(cardText(card), /未恢复/);
}

// --- the commit on a standing row -----------------------------------------------

// The question the standing section was leaving open. "2.5x slower" invites
// "since when", and the confirmed layer worked that out in the same pass.
{
  const row = {
    ...standingOf("climbed", 2.5),
    introducedBy: {
      beforeCommit: "e5828c2f1111111111111111111111111111aaaa",
      afterCommit: "1dd78a15222222222222222222222222222bbbb0",
      alsoPossible: [],
      unmeasuredBetween: 0,
    },
    otherSteps: 3,
  };
  const line = formatStandingLine(row, "");
  assert.match(line, /最大台阶在 `e5828c2f`→`1dd78a15`/);
  // The four-step fanout staircase is why this count is printed rather than
  // dropped: one of four commits named alone reads as the whole cause.
  assert.match(line, /另有 3 处台阶/);
  // Short SHAs only. A full 40-character hash on a card is unreadable, and the
  // repository this is pushed from is public while teable-ee is not — a SHA is
  // carried, a commit subject never is.
  assert.doesNotMatch(line, /e5828c2f1111/);
}

// An unmeasured range is not a ±1 neighbourhood, and the row says which it is.
{
  const line = formatStandingLine(
    {
      ...standingOf("gappy", 1.8),
      introducedBy: {
        beforeCommit: "aaaaaaaa",
        afterCommit: "bbbbbbbb",
        alsoPossible: [],
        unmeasuredBetween: 12,
      },
      otherSteps: 0,
    },
    "",
  );
  assert.match(line, /区间内 12 个 commit 未测/);
  assert.doesNotMatch(line, /另有/);
}

// Both silent cases say why they are silent. A row that stops after the ratio
// reads as a lookup that failed.
{
  assert.match(
    formatStandingLine(
      { ...standingOf("noisy", 2.8), unattributed: "screened" },
      "",
    ),
    /波动太大/,
  );
  assert.match(
    formatStandingLine(
      { ...standingOf("sloped", 1.6), unattributed: "no-step" },
      "",
    ),
    /渐变/,
  );
}

// The ±1 caveat follows the SHAs, wherever they are. A standing-only card is
// the common one — a night with no new change point is the normal night — and
// hanging the caveat under the change point section alone would ship SHAs
// without it on exactly those nights.
{
  const attributed = {
    ...standingOf("climbed", 2.5),
    introducedBy: {
      beforeCommit: "aaaaaaaa",
      afterCommit: "bbbbbbbb",
      alsoPossible: [],
      unmeasuredBetween: 0,
    },
    otherSteps: 0,
  };
  const text = cardText(
    buildChangePointCard({
      result: { ...resultOf(), standing: [attributed] },
      context,
      seen: [],
    }),
  );
  assert.ok(text.includes(ATTRIBUTION_NOTE));
  // And the framing a SHA needs: that it is a mainline commit, possibly much
  // older than the build this run measured.
  assert.match(text, /commit 归属于 mainline/);
}

// --- the seen-set survives a card going out ----------------------------------

// The failure this guards is silent and it cost a night's findings every time
// the card had something to say: rewriting the seen-set field by field dropped
// `metrics`, the next run read that as the corpus changing what it records, and
// it re-seeded — folding everything it found in and announcing none of it.
{
  const before = {
    known: ["case@a..b"],
    window: null,
    metrics: "overheadMs>pagedScanMs",
    // Stands in for whatever the seen-set grows next. This step must not need
    // to know about it.
    somethingAddedLater: { count: 3 },
  };
  const after = seenAfterCard(before, ["standing:record-read/case"]);
  assert.deepEqual(after.known, ["case@a..b", "standing:record-read/case"]);
  for (const field of ["window", "metrics", "somethingAddedLater"]) {
    assert.deepEqual(
      after[field],
      before[field],
      `${field} was dropped when the card marked its standing cases; the next run re-seeds and announces nothing`,
    );
  }
  // Idempotent, so a retried step does not grow the file.
  assert.deepEqual(seenAfterCard(after, ["standing:record-read/case"]), after);
  // And a missing or unusable file is a first run, not a crash.
  assert.deepEqual(seenAfterCard(undefined, ["standing:x"]), {
    known: ["standing:x"],
  });
  assert.deepEqual(seenAfterCard([], []), { known: [] });
}

// --- how long a standing case has been slow -----------------------------------

// The duration comes from the incident pairing, which the standing list does
// not always have a counterpart in. Where it does, the row says it; where it
// does not, the row is what it always was rather than carrying a made-up
// number.
{
  assert.equal(standingDurationText({ openDays: 19.4 }), "已持续 19 天");
  assert.equal(standingDurationText({ openDays: 0.4 }), "已持续 0 天");
  assert.equal(standingDurationText({}), undefined);
  assert.equal(standingDurationText({ openDays: null }), undefined);

  const line = formatStandingLine(
    { ...standingOf("slow", 1.8), openDays: 12.2 },
    "https://chart.example",
  );
  // The duration is only ever attached upstream for incidents V2 actually
  // moved on; a row that reached here without one prints no duration at all.
  assert.match(line, /已持续 12 天/);
  assert.ok(
    !formatStandingLine(
      standingOf("slow", 1.8),
      "https://chart.example",
    ).includes("已持续"),
  );
}

console.log("change point card model checks passed");
