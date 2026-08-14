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
  isRegression,
  rankRegressions,
  reportedFactor,
} from "./change-point-attribution-model.mjs";
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

// Rows in the standing section. Fifteen cases qualified across the whole
// history on 2026-08-13, which is more than a card should open with and not so
// many that the rest are unreachable — the remainder folds away.
export const STANDING_LIMIT = 6;

// Re-exported rather than redefined. Both live with attribution now — the
// standing join needs the same rule, and `standing-regression-model.mjs` cannot
// import this file without a cycle.
export { isRegression, reportedFactor };

// What the standing section is, in the two sentences a reader needs before the
// rows make sense. It is not the change point list twice: those rows say a
// commit moved something *this run*, these say a case has not come back,
// however long ago it went.
export const STANDING_NOTE =
  "当前比历史起点慢的用例，不论多久以前造成的。修好了会自动消失。";

// Only when a change point section sits above it. On a card pushed for a newly
// standing case there is no "上面" to contrast with, and the sentence sends the
// reader looking for a section that is not there.
export const STANDING_CONTRAST =
  "与上面的区别：上面是本轮新确认的，这里是至今没恢复的，可能是几周前的事。";

// Owed to triage since the ±1 tolerance was signed off, and never delivered
// anywhere a person reads. `docs/perf-alerting-todo.md` records the case it
// came from: on `record-read/50k-50fields-group-number-low-cardinality` the
// boundary landed one position late and the change point named an innocent
// neighbour. A SHA in an alert reads as "this one", and whoever triages opens
// exactly the commit named.
//
// Rendered wherever a SHA is, which is both sections now that standing rows
// carry one. Hanging it under the change point section alone would put SHAs on
// a standing-only card with the caveat missing — and the standing-only card is
// the common one, since a night with no new change point is the normal night.
export const ATTRIBUTION_NOTE =
  "定位精度为相邻 1 个 commit。命名的 commit 可能是真凶的邻居，两个都要看。标出「区间内 N 个未测」的，真凶在这段范围里，不止命名的这一个。";

// The rows the card shows, worst first. The rule is the same one the standing
// join uses, and lives with attribution; the count of what it excluded is
// stated on the card so the exclusion is visible rather than silent.
export const rankChangePoints = rankRegressions;

const shortSha = (sha) => (typeof sha === "string" ? sha.slice(0, 8) : "?");

/**
 * Both ends of a range in one unit.
 *
 * `formatMetricSeconds` switches at 100ms, which is right for a single figure
 * and wrong for a pair: `56ms → 0.15s` asks the reader to convert before they
 * can see it roughly tripled. The larger end picks the unit for both.
 */
export const formatRange = (then, now) =>
  Math.max(then, now) < 100
    ? `${Math.round(then)}ms → ${Math.round(now)}ms`
    : `${(then / 1000).toFixed(2)}s → ${(now / 1000).toFixed(2)}s`;

/**
 * Where the largest step landed, or why there is no commit to name.
 *
 * A standing row without this was the card's loudest omission: "2.5x slower"
 * with no answer to "since when". The commit is not new information — the
 * confirmed layer works it out in the same pass over the same history — it was
 * being computed and dropped, because the two lists were assembled separately.
 *
 * The two silent cases are named rather than left blank. A row that just stops
 * after the ratio reads as a lookup that failed, and the reason it stopped is
 * worth as much as a SHA would be: `noisy` means detection was never allowed to
 * look, `渐变` means it looked and found no step.
 */
export const standingAttributionText = (row) => {
  const introduced = row?.introducedBy;
  if (!introduced) {
    return row?.unattributed === "screened"
      ? "波动太大，检测不到台阶"
      : "渐变，没有单个台阶";
  }
  const parts = [
    `最大台阶在 \`${shortSha(introduced.beforeCommit)}\`→\`${shortSha(introduced.afterCommit)}\``,
  ];
  if (row.otherSteps > 0) {
    // A staircase, not a step. Four consecutive mainline commits each moved the
    // fanout cases, and naming one of the four as the cause would be wrong in a
    // way the row cannot show.
    parts.push(`另有 ${row.otherSteps} 处台阶`);
  }
  if (introduced.unmeasuredBetween > 0) {
    parts.push(`区间内 ${introduced.unmeasuredBetween} 个 commit 未测`);
  }
  return parts.join(" · ");
};

export const formatStandingLine = (row, chartUrl) =>
  `**[${row.caseId}](${chartUrlForCase(row.caseId, chartUrl)})**\n` +
  `${formatRange(row.v2Then, row.v2Now)} · ` +
  `${formatRatioFactor(row.pairedDrift) ?? "—"} · ${row.points} 个历史点\n` +
  standingAttributionText(row);

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
/**
 * Standing entries this run has not pushed before.
 *
 * The standing list itself repeats by design — "still slower" is true every day
 * until someone fixes it. But a case *arriving* on it is news, and it is news
 * the confirmed layer can miss entirely: `record-read/10k-50fields-group-three-levels`
 * has drifted 2.82x against its control and the measurability screen keeps it
 * out of detection, so no change point will ever announce it.
 *
 * Compared against the seen-set the confirmed layer already carries, under a
 * key that cannot collide with a change point's `case@before..after`.
 */
export const standingKey = (row) => `standing:${row?.caseId}`;

export const freshStanding = (standing = [], seen = []) => {
  const known = new Set(seen);
  return standing.filter((row) => !known.has(standingKey(row)));
};

export const describeDelivery = ({ result, seen = [] } = {}) => {
  const summary = summariseChangePoints(result?.confirmed ?? []);
  const standing = result?.standing ?? [];
  const newlyStanding = freshStanding(standing, seen);
  if (isColdStart(result)) {
    return {
      send: false,
      reason:
        `cold start: the seen-set was empty, so this run re-reported ${summary.total} change points from history ` +
        `(${summary.regressions.length} of them slowdowns). Not pushed — these are not new. ` +
        `Check why the seen-set was lost; the findings are in the artifact.`,
    };
  }
  if (summary.regressions.length === 0 && newlyStanding.length > 0) {
    return {
      send: true,
      reason:
        `no new confirmed slowdowns, but ${newlyStanding.length} case(s) newly standing slower than they started; pushing a card.`,
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
    reason:
      `${summary.regressions.length} new confirmed slowdowns of ${summary.total} change points; ` +
      `${standing.length} standing (${newlyStanding.length} new); pushing a card.`,
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
export const buildChangePointCard = ({ result, context = {}, seen = [] } = {}) => {
  if (!describeDelivery({ result, seen }).send) {
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
  const standing = result?.standing ?? [];
  const newlyStanding = freshStanding(standing, seen);
  const shownStanding = standing.slice(0, STANDING_LIMIT);
  const restStanding = standing.slice(STANDING_LIMIT);
  const renderStanding = (rows) =>
    rows
      .map((row) => formatStandingLine(row, context.chartUrl))
      .join("\n\n");

  const hasChangePoints = summary.regressions.length > 0;
  // Whether anything on this card names a commit. Both sections do now, and the
  // framing a SHA needs — that it is a mainline commit which may be much older
  // than tonight's build — belongs to whichever section put one there.
  const namesACommit =
    hasChangePoints || standing.some((row) => row.introducedBy);
  const headLines = [
    [
      hasChangePoints
        ? `**新确认变慢 ${summary.regressions.length}**${severe > 0 ? ` · 其中 ${severe} 个达到 ${SEVERE_CHANGE_POINT_RATIO}x` : ""}`
        : "**本轮没有新确认的变更点**",
      ...(standing.length > 0
        ? [
            `**目前未恢复 ${standing.length}**${newlyStanding.length > 0 ? `（${newlyStanding.length} 个新增）` : ""}`,
          ]
        : []),
    ].join(" · "),
    ...(hasChangePoints
      ? [`本轮共确认 ${summary.total} 个变更点，另外 ${breakdown}，不在下面`]
      : []),
    ...(namesACommit
      ? [
          `commit 归属于 mainline${context.teableRef ? `，可能比本轮测的 \`${shortSha(context.teableRef)}\` 早很多` : "，不一定是本轮测的版本"}`,
        ]
      : []),
    `耗时均为 V2`,
  ];

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true, enable_forward: true },
      header: {
        template:
          severe > 0 ||
          standing.some((row) => row.pairedDrift >= SEVERE_CHANGE_POINT_RATIO)
            ? "red"
            : "orange",
        title: {
          tag: "plain_text",
          content: hasChangePoints
            ? `变更点 · 新确认变慢 ${summary.regressions.length}` +
              (standing.length > 0 ? ` · 未恢复 ${standing.length}` : "")
            : `性能未恢复 ${standing.length}`,
        },
      },
      elements: [
        larkDiv(headLines.join("\n")),
        // The change point section only when there is one. A card pushed for a
        // newly standing case would otherwise open with an empty row block and
        // a note explaining commit attribution it does not do.
        ...(hasChangePoints
          ? [
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
            ]
          : []),
        // Second section, and a different question: not who moved something,
        // but what has not come back. Folded open when a case has just joined
        // it, shut when the list is only yesterday's list again.
        ...(standing.length > 0
          ? [
              { tag: "hr" },
              collapsiblePanel({
                title: `目前未恢复 ${standing.length}${newlyStanding.length > 0 ? ` · 新增 ${newlyStanding.length}` : ""}`,
                expanded: newlyStanding.length > 0,
                elements: [
                  larkDiv(
                    hasChangePoints
                      ? `${STANDING_NOTE}${STANDING_CONTRAST}`
                      : STANDING_NOTE,
                  ),
                  larkDiv(renderStanding(shownStanding)),
                  ...(restStanding.length > 0
                    ? [
                        collapsiblePanel({
                          title: `其余 ${restStanding.length}`,
                          elements: [larkDiv(renderStanding(restStanding))],
                        }),
                      ]
                    : []),
                ],
              }),
            ]
          : []),
        // Once, below both sections, rather than under the change point rows.
        // Standing rows name commits too, and the standing-only card is the
        // common one — a quiet night for the detector is the normal night.
        ...(namesACommit ? [larkDiv(ATTRIBUTION_NOTE)] : []),
        { tag: "hr" },
        linkButtons(context),
      ],
    },
  };
};
