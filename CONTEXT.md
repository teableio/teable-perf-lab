# Performance Trace Evidence

This context defines which traces constitute durable diagnostic evidence for
performance cases and which traces are incidental execution noise.

## Language

**Measured Trace**:
A complete distributed trace from a Tested Interface, selected as evidence for
one Request Shape at one Trace Checkpoint within a case and engine.
_Avoid_: Case trace, captured trace

**Performance Run**:
One complete execution that produces performance measurements and their
diagnostic evidence.
_Avoid_: First trace run, trace-optional retry

**Tested Interface**:
The product API operation whose performance a case exists to measure. Fixture
setup, readiness checks, verification reads, polling, and cleanup are not Tested
Interfaces.
_Avoid_: Traced interface, primary request

**Seed Phase**:
The phase that prepares deterministic fixtures for later performance
measurement.
_Avoid_: Setup run, measured setup

**Completion Probe**:
A follow-up read or poll used to decide when an operation has become observable
or correct. It may contribute to a completion metric but is not a Tested
Interface and does not require a Measured Trace.
_Avoid_: Verification request, measured read

**Request Shape**:
The semantic identity of a measured request, distinguished by its measured
step, HTTP method, route shape, request-body structure, case, and engine.
_Avoid_: Request, sample

**Cost Dimension**:
A request parameter whose value can materially change execution cost without
changing the Request Shape, such as pagination depth, batch position, fanout, or
payload size.
_Avoid_: Iteration, sequence number

**Trace Checkpoint**:
A predeclared representative point along a Cost Dimension where a Measured
Trace is required, normally the minimum, median, and maximum.
_Avoid_: Sample, trace index

**Failure Checkpoint**:
An invocation of a Tested Interface that ends in an explicit failure and
therefore becomes diagnostic evidence.
_Avoid_: Slow trace, exceptional trace

**Background Trace**:
A trace produced outside the measured request, including fixture preparation,
initialization, verification, polling, and cleanup. It is not performance
evidence for the case.
_Avoid_: Verification trace, setup trace
