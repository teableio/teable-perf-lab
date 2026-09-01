# Architecture decision records

Decisions that a later architecture review should not re-open as if they were
new findings. Each record states what was investigated, what was decided, and
what it would take to revisit. A record may retain an existing design or adopt
a new one; ADRs capture consequential architectural choices, not only reasons
to leave code unchanged.

Add a record when a consequential boundary, evidence model, or operational
constraint would otherwise be easy to rediscover or accidentally reverse.

- [0001: Full-run case cost has two sources](0001-full-run-case-cost-has-two-sources.md)
- [0002: Keep the performance control plane separate from the runtime](0002-separate-control-plane-and-runtime.md)
- [0003: Separate historical detection from causal regression proof](0003-separate-detection-from-causal-proof.md)
