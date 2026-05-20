# teable-perf-lab

Performance regression lab for Teable v2.

This repository is intended to become the control plane for Teable performance
regression validation:

- define reproducible performance cases as code
- provision isolated Teable spaces backed by BYODB data databases
- run API-level end-to-end workloads against preview or release targets
- persist run history, metrics, artifacts, and trace snapshots
- publish manual and scheduled regression reports

The first milestone is a reviewed implementation plan. See
[docs/plan.md](docs/plan.md).

