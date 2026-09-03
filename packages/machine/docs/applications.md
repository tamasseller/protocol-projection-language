# Application domains

> **Status:** the intended uses, for checking a design decision against.
> Not normative — nothing here constrains a conforming implementation.
> MOG is the machine, ISA, DSL, lowerer, validator, VM and JIT; PPL is the
> protocol projection language MOG was first built for, and one application
> among several. Both still live in one tree (`docs/TODO.md`, "The move").

## MOG

A bounded execution environment for small program fragments injected into an
MCU-based system at run time, without building a firmware image for them.
Scripted behaviour without a scripting engine's resource footprint,
unpredictability or performance penalty.

The core is domain-independent — arithmetic, control flow, program state
(isa-core.md §1). Everything an application needs to touch its environment
arrives as a domain extension (§11): the implement bolted to the chassis.
Applications differ in their extension, not in the core.

Intended applications, each with its own extension:

- Trigger and qualifier expressions on a logic analyzer or DSO.
- SWD/JTAG sequences run on the debugger probe itself, so a programming or
  end-of-line-test operation is not paced by USB frame delays.
- Trigger and reduction expressions on data acquisition devices.
- Packet sniffer filters.
- Wire-format codecs — PPL below, and the one application that does not run
  on the JIT.

## The performance bar

Not competitive with well-optimized native code, and not aiming to be.
Choosing MOG for a fragment should cost a somewhat beefier MCU, not an order
of magnitude — close enough to `-Og` output that *some* numbercrunching is
in reach. The ISA is shaped so the JIT stays simple and the DSL lowerer need
not be a proper compiler (isa-rationale.md). Within that: take the
low-hanging fruit, don't get crazy.

## PPL

Bidirectional mappings between semantic object graphs and wire
representations (`docs/protocol-projection-language.md`). The domain is
embedded device ↔ host application (desktop, mobile, server) over whatever
channel carries it — USB, BLE, IP over LAN or WiFi, a cellular modem.

- Device end: C/C++ generated at build time from the semantic type
  definition, the target projection and the wire-format codec projection.
  No dynamic allocation, wire-buffer management behind an interface the
  application glues up.
- Host end: js/ts generated at run time from a portable codec image, taken
  from the partner device itself or from an artifact repository.
- Codecs are a codegen application, not a JIT one. The device end gets
  generated native code and the host end accommodates it, so the JIT is
  never a codec target and the codec extension has no reason to be ported
  to it.

## What this constrains

- A fragment is small — tens of instructions per procedure, not thousands.
- A frame holds locals and temporaries. No arrays, no bulk application
  data: that belongs to the extension's own storage, so operand-stack
  frames of several hundred bytes are not a realistic shape.
- Realistic programs are written against a four-entry register window —
  arguments, locals and live temporaries together
  (`jit-armv6m/docs/target-profile.md`).
- Construct frequency across the test suite, the DSL corpus, the codecs and
  the bench workloads says nothing about real programs; those exist to
  exercise paths. A tradeoff that turns on how often something occurs needs
  a workload from one of the domains above, not a corpus count.
