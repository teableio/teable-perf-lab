import assert from "node:assert/strict";
import {
  ATTRIBUTION_NOTE,
  buildChangePointCard,
  CHANGE_POINT_HIGHLIGHT_LIMIT,
  describeDelivery,
  extraSuspects,
  formatChangePointLine,
  isColdStart,
  isRegression,
  rankChangePoints,
  reportedFactor,
  SEVERE_CHANGE_POINT_RATIO,
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
assert.equal(isRegression(pointOf({ ratio: 1.5, before: 400, after: 600 })), true);
assert.equal(isRegression(pointOf({ ratio: 0.7, before: 600, after: 400 })), false);

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
    pointOf({ caseId: "v1-mover", ratio: 2.2, mover: "v1", before: 37, after: 40 }),
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
    pointOf({ caseId: "control", ratio: 2.2, mover: "v1", before: 37, after: 40 }),
    pointOf({ caseId: "v1-sped-up", ratio: 1.3, mover: "v2", before: 1231, after: 627 }),
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
  assert.equal(reportedFactor(pointOf({ before: 613, after: 1216 })), 1216 / 613);
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
  extraSuspects(
    pointOf({ beforeCommit: "aaaa1111", afterCommit: "bbbb2222" }),
  ).length,
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
  assert.equal(buildChangePointCard({ result: resultOf(), context }), undefined);
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
  const confirmed = Array.from({ length: CHANGE_POINT_HIGHLIGHT_LIMIT + 3 }, (_, index) =>
    pointOf({ caseId: `case-${index}`, ratio: 1.9 - index * 0.05 }),
  );
  const card = buildChangePointCard({ result: resultOf({ confirmed }), context });
  const panel = card.card.elements.find(
    (element) => element.tag === "collapsible_panel",
  );
  assert.match(panel.header.title.content, /其余 3/);
  const text = cardText(card);
  for (const point of confirmed) {
    assert.match(text, new RegExp(point.caseId));
  }
}

console.log("change point card model checks passed");
