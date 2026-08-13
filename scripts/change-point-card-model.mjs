// The change point card: the second Feishu message of the night.
//
// A separate card rather than a panel on the run summary, for a reason of
// sequence rather than taste. The run summary is sent at step 17 of the report
// job; the shadow analysis that produces change points finishes at step 30,
// about nine and a half minutes later on a run that takes thirty. Folding this
// into the first card means holding that card back for the analysis, and the
// analysis is the part allowed to fail.
//
// The two cards answer different questions and that is the other half of it.
// The run summary asks "is this build slower than the release" and its subject
// is this run. This one asks "where did the mainline move" and its subject is a
// commit, which may be a hundred commits old and belong to nobody who is
// looking at tonight's run.
//
// Only the confirmed layer is carried here. The same-run layer — the one that
// flags cases against their own noise bar as the run completes — disagrees with
// the release comparison already on the first card, and by a lot: on 2026-08-11
// the old gate flagged 32 cases and the same-run layer flagged 5, agreeing on
// 4. Two panels in one chat giving different counts for the same question is
// not information, and which of them is right is exactly what acceptance G3
// settles. Until it does, the same-run layer stays in the job summary.
//
// Nothing is sent on a quiet night. A card that reads "新确认 0" every night is
// a card nobody opens on the night it says something else. The audit trail that
// must not go quiet — ten shadow runs cannot pass for ten empty ones — is the
// job summary and the artifact, both of which are written either way.

import {
  chartUrlForCase,
  collapsiblePanel,
  formatMetricSeconds,
  formatRatioFactor,
  larkDiv,
  linkButtons,
} from "./perf-run-summary-model.mjs";

// Five rows, then a count. The most a full run has confirmed in one night over
// the 133 artifacts on hand is 6, so this trims almost nothing — it is a bound
// against the cold-start case, which reports its whole recent history at once
// and has produced 117.
export const CHANGE_POINT_HIGHLIGHT_LIMIT = 5;

// A card is red at this factor or above. Two of the twelve V2 slowdowns found
// so far are 3x, and a 3x sitting in the same colour as a 1.2x is the reason to
// have a second colour at all.
export const SEVERE_CHANGE_POINT_RATIO = 2;

/**
 * How much this case slowed, in its own wall-clock terms.
 *
 * Detection runs on `log(v2) − log(v1)` and `ratio` is that paired figure. The
 * V1 control channel is what makes detection immune to a runner that was slow
 * all night, and it stays — but it is a ruler, not a finding, and it is not on
 * this card. A reader who is shown "0.42s → 1.01s" beside a paired "2.3x" is
 * being asked to reconcile two numbers that do not divide into each other.
 *
 * So the row is judged on the pair and reported on V2. Where a record carries
 * no levels — everything written before attribution existed — the paired ratio
 * is all there is, and it is used rather than the row being dropped.
 */
export const reportedFactor = (point) => {
  const before = point?.v2Level?.before;
  const after = point?.v2Level?.after;
  if (Number.isFinite(before) && Number.isFinite(after) && before > 0) {
    return after / before;
  }
  return point?.ratio;
};

// Owed to triage since the ±1 tolerance was signed off, and never delivered
// anywhere a person reads. `docs/perf-alerting-todo.md` records the case it
// came from: on `record-read/50k-50fields-group-number-low-cardinality` the
// boundary landed one position late and the change point named an innocent
// neighbour. A SHA in an alert reads as "this one", and whoever triages opens
// exactly the commit named.
export const ATTRIBUTION_NOTE =
  "定位精度为相邻 1 个 commit。命名的 commit 可能是真凶的邻居，两个都要看。标出「区间内 N 个未测」的，真凶在这段范围里，不止命名的这一个。";

/**
 * Did V2 itself get slower here, or did the pair separate because V1 got
 * faster?
 *
 * The detector runs on `log(v2) − log(v1)`, so `ratio` above 1 means the gap
 * widened and nothing more. One of the thirteen V2-mover slowdowns on record
 * reads 1.28x on the pair while V2 went 1231ms to 627ms — a case that got
 * twice as fast, on a card that would have called it a regression.
 *
 * `v2Level` is absent on records written before attribution existed. Those are
 * kept rather than dropped: the ratio is all there is, and silently discarding
 * the rows that cannot be checked would shrink the list without saying so.
 */
export const isRegression = (point) => {
  if (!Number.isFinite(point?.ratio) || point.ratio <= 1) {
    return false;
  }
  const before = point.v2Level?.before;
  const after = point.v2Level?.after;
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return true;
  }
  return after > before;
};

// Ordered and coloured on what the row actually says, so the top row is the
// worst slowdown a reader can see rather than the widest gap against a control
// the card never mentions.
const magnitude = (point) => {
  const factor = reportedFactor(point);
  return Number.isFinite(factor) && factor > 0 ? Math.abs(Math.log(factor)) : 0;
};

/**
 * The rows the card shows, worst first.
 *
 * Speedups are excluded rather than sorted to the bottom. Two thirds of all
 * confirmed change points are speedups — 246 of 363 across the artifacts on
 * hand — and there is no action to take on one. Their count is stated on the
 * card so the exclusion is visible rather than silent.
 *
 * `mover: v1` is excluded for a stronger reason than ranking it last. The
 * printed levels are V2's and the printed ratio is the pair's, and on a v1 row
 * those two disagree past the point of being read together: `table-delete/50k-20f`
 * renders as "37ms → 40ms · 慢2.2x", which is a flat series beside a 2.2x. The
 * 2.2x is real and it is entirely V1 getting faster. There is nothing in V2 to
 * open, so it is counted with the control-side changes instead.
 */
export const rankChangePoints = (confirmed = []) =>
  confirmed
    .filter((point) => point?.mover !== "v1" && isRegression(point))
    .sort((left, right) => magnitude(right) - magnitude(left));

const shortSha = (sha) => (typeof sha === "string" ? sha.slice(0, 8) : "?");

/**
 * The commits `alsoPossible` names that the row does not already print.
 *
 * `alsoPossible` normally holds the boundary's own two commits, and repeating
 * them under a row that just named them adds a line and no fact.
 */
export const extraSuspects = (point) => {
  const named = new Set([point?.beforeCommit, point?.afterCommit]);
  return (point?.alsoPossible ?? []).filter((sha) => sha && !named.has(sha));
};

const levelText = (point) => {
  const before = point?.v2Level?.before;
  const after = point?.v2Level?.after;
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    // No absolute levels on this record, so the ratio is the whole statement.
    // Printing "— → —" beside it would look like missing data rather than a
    // record written before the levels existed.
    return undefined;
  }
  // Unlabelled, because every number on this card is V2's and the header says
  // so once. Repeating "V2" on each row only raises the question of what the
  // other engine did, which is a question this card does not answer.
  return `${formatMetricSeconds(before)} → ${formatMetricSeconds(after)}`;
};

export const formatChangePointLine = (point, chartUrl) => {
  const parts = [];
  const levels = levelText(point);
  if (levels) {
    parts.push(levels);
  }
  const factor = formatRatioFactor(reportedFactor(point));
  if (factor) {
    parts.push(factor);
  }
  if (Number.isFinite(point.pValue)) {
    parts.push(`p=${point.pValue}`);
  }
  parts.push(
    `引入于 \`${shortSha(point.beforeCommit)}\`→\`${shortSha(point.afterCommit)}\``,
  );
  const extras = extraSuspects(point);
  if (extras.length > 0) {
    parts.push(`同样可疑 ${extras.map((sha) => `\`${shortSha(sha)}\``).join("、")}`);
  }
  if (point.unmeasuredBetween > 0) {
    parts.push(`区间内 ${point.unmeasuredBetween} 个 commit 未测`);
  }
  return `🔴 **[${point.caseId}](${chartUrlForCase(point.caseId, chartUrl)})**\n${parts.join(" · ")}`;
};

/**
 * Split tonight's confirmed change points into what the card says and what it
 * only counts.
 *
 * `unchanged` is the bucket that exists because detection and reporting use
 * different measurements: something moved, and it was not this case getting
 * slower. It is counted rather than listed because there is nothing here to
 * open, and counted rather than dropped because "变慢 0" over a night that
 * produced six change points is a claim the reader would check against the
 * artifact and find wrong.
 *
 * The three buckets are defined to sum to `total`, so the card's own arithmetic
 * is checkable by the person reading it.
 */
export const summariseChangePoints = (confirmed = []) => {
  const regressions = rankChangePoints(confirmed);
  // Counted on what the card would report, not on the paired ratio, so the
  // three buckets describe the same measurement the rows do.
  const faster = confirmed.filter((point) => {
    const factor = reportedFactor(point);
    return Number.isFinite(factor) && factor < 1;
  }).length;
  return {
    regressions,
    faster,
    unchanged: confirmed.length - regressions.length - faster,
    total: confirmed.length,
  };
};

/**
 * A run that started from an empty seen-set is reporting history, not news.
 *
 * `seenBefore` is 0 on the first run of all, and on any run whose cached
 * seen-set was lost — which has happened: on 2026-08-09 the cache missed
 * silently, the analysis read an empty set, and the run reported 117 change
 * points as new. Twenty-five of those are regressions by every test on this
 * card, and every one of them had been reported days earlier.
 *
 * The same reasoning the seen-set was built on decides this: nobody reads an
 * alert that repeats itself. The findings are not lost — the job summary and
 * the artifact carry them either way — so this suppresses the push and says so
 * where CI is watched.
 */
export const isColdStart = (result) => (result?.seenBefore ?? 0) === 0;

/**
 * Why this run does or does not push a card, in one line for the step log.
 *
 * Separate from the card so the sender can report the quiet nights too. A
 * delivery rule that only speaks when it fires cannot be distinguished from a
 * broken one.
 */
export const describeDelivery = ({ result } = {}) => {
  const summary = summariseChangePoints(result?.confirmed ?? []);
  if (isColdStart(result)) {
    return {
      send: false,
      reason:
        `cold start: the seen-set was empty, so this run re-reported ${summary.total} change points from history ` +
        `(${summary.regressions.length} of them slowdowns). Not pushed — these are not new. ` +
        `Check why the seen-set was lost; the findings are in the artifact.`,
    };
  }
  if (summary.regressions.length === 0) {
    return {
      send: false,
      reason:
        summary.total === 0
          ? "no new confirmed change points; nothing pushed."
          : `${summary.total} new change point${summary.total === 1 ? "" : "s"}, none of them a slowdown ` +
            `(${summary.faster} faster, ${summary.unchanged} unchanged); nothing pushed.`,
    };
  }
  return {
    send: true,
    reason: `${summary.regressions.length} new confirmed slowdowns of ${summary.total} change points; pushing a card.`,
  };
};

/**
 * The card, or `undefined` when there is nothing to send.
 *
 * Returning `undefined` rather than an empty card is the whole delivery rule
 * in one place: the sender pushes what this returns and pushes nothing when it
 * returns nothing, so "when do we stay quiet" is answered here and testable
 * without a webhook.
 */
export const buildChangePointCard = ({ result, context = {} } = {}) => {
  if (!describeDelivery({ result }).send) {
    return undefined;
  }
  const summary = summariseChangePoints(result?.confirmed ?? []);

  const shown = summary.regressions.slice(0, CHANGE_POINT_HIGHLIGHT_LIMIT);
  const rest = summary.regressions.slice(CHANGE_POINT_HIGHLIGHT_LIMIT);
  const severe = summary.regressions.filter(
    (point) => point.ratio >= SEVERE_CHANGE_POINT_RATIO,
  ).length;
  const renderRows = (rows) =>
    rows.map((point) => formatChangePointLine(point, context.chartUrl)).join("\n\n");

  // What the reader needs before the rows: that these are not tonight's build.
  // A change point is attributed to a mainline commit, and the run that found
  // it is only the run whose data made the boundary significant — often days
  // after the commit landed.
  const breakdown = [
    `${summary.faster} 个变快`,
    ...(summary.unchanged > 0 ? [`${summary.unchanged} 个耗时没变`] : []),
  ].join("、");
  const headLines = [
    `**新确认变慢 ${summary.regressions.length}**${severe > 0 ? ` · 其中 ${severe} 个达到 ${SEVERE_CHANGE_POINT_RATIO}x` : ""}`,
    `本轮共确认 ${summary.total} 个变更点，另外 ${breakdown}，不在下面`,
    `耗时均为 V2`,
    `变更点归属于 mainline 上的某个 commit${context.teableRef ? `，可能比本轮测的 \`${shortSha(context.teableRef)}\` 早很多` : "，不一定是本轮测的版本"}`,
  ];

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template: severe > 0 ? "red" : "orange",
        title: {
          tag: "plain_text",
          content: `变更点 · 新确认变慢 ${summary.regressions.length}`,
        },
      },
      elements: [
        larkDiv(headLines.join("\n")),
        { tag: "hr" },
        larkDiv(renderRows(shown)),
        ...(rest.length > 0
          ? [
              collapsiblePanel({
                title: `其余 ${rest.length}`,
                elements: [larkDiv(renderRows(rest))],
              }),
            ]
          : []),
        larkDiv(ATTRIBUTION_NOTE),
        { tag: "hr" },
        linkButtons(context),
      ],
    },
  };
};
