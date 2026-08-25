# Robot Mission Studio — Product Requirements

**Project:** 10xDevs 3.0 capstone · **Owner:** Mariusz · **Submission:** 16.09.2026
**Status:** v1 — scope locked

---

## 1. Problem

Specifying a mission for a mobile warehouse robot is currently a hardware-in-the-loop activity. An ops engineer or integrator writes a task sequence, deploys it to a robot or a heavyweight simulator, and only then discovers the obvious mistakes: a station that can't be reached around an obstacle, a `place` with no preceding `pick`, a route that exhausts the battery two stops from the charger.

The feedback loop is hours long for errors that are structurally detectable in milliseconds. And the people who most often write these specs — pre-sales engineers, integrators, ops leads — are frequently not the people with a robot on their desk.

## 2. Solution

A browser tool with three moves:

1. **Draw** a floor layout — a grid with obstacles and named stations.
2. **Describe** the mission in one plain-language sentence.
3. **Run** it in a deterministic simulator and, on failure, read an AI-generated explanation of what went wrong and what to change.

No hardware, no install, no robotics background required to get a useful answer.

## 3. Target users

| Persona | Need | What they get |
|---|---|---|
| **Integration engineer** | Sanity-check a mission before it touches a robot | Structural validation + visual run in under a minute |
| **Pre-sales / solution engineer** | Show a customer their own warehouse working | Shareable layout, plain-language mission input |
| **Ops lead** | Understand why yesterday's mission failed | Postmortem in language they can act on |

Primary persona for v1 is the **integration engineer**. Where the personas conflict, they win.

## 4. Goals

- Turn a natural-language brief into a valid, executable mission plan.
- Detect and clearly report every structural failure class before deployment.
- Make a failed run *understandable*, not just red.
- Runs are fully reproducible — same layout, plan, and seed always give the same result.

## 5. Non-goals

Explicitly not solving, and not accepting scope creep toward:

- Physical accuracy — no physics engine, no dynamics, no kinematics
- Robotic arms, inverse kinematics, grasp planning
- 3D visualisation
- Multi-robot fleets or traffic coordination
- ROS / ROS2 integration, or any connection to real hardware
- Path optimisation beyond A*
- Real-time collaboration or sharing between users
- Mobile-optimised UI (desktop-first, unapologetically)

This list is binding. It is the answer to "wouldn't it be cool if…" at 23:00.

## 6. User stories

### US-1 — Authentication
**As a** user **I can** sign up and log in with email and password
**Acceptance:** session persists across reloads; unauthenticated access to any `/app/*` route redirects to login; my layouts, missions, and runs are invisible to every other user.

### US-2 — Layout authoring
**As a** user **I can** create a grid layout with obstacles and named stations
**Acceptance:** grid between 5×5 and 30×30; cells toggle between free and obstacle; stations have a name and a kind (`dock` / `shelf` / `charger`); a start cell is required; layout persists and reloads identically.

### US-3 — Mission generation
**As a** user **I can** describe a mission in natural language and receive a structured plan
**Acceptance:** the brief plus the layout's station list produces a schema-valid `Mission`; invalid model output is repaired automatically (max 2 attempts) or fails with a clear message; the plan is displayed as an ordered, readable step list.

### US-4 — Plan editing
**As a** user **I can** edit the generated plan step by step
**Acceptance:** steps can be reordered, edited, and deleted; validation issues appear live as I edit; a plan with issues can still be saved but cannot be run.

### US-5 — Simulation and playback
**As a** user **I can** run a mission and watch it execute
**Acceptance:** robot animates cell by cell along its path; play/pause available; final metrics shown (ticks, distance, battery remaining); failures halt playback at the failing step with the step highlighted.

### US-6 — Failure postmortem
**As a** user **I can** understand why a run failed without reading a trace
**Acceptance:** failed runs show a plain-language diagnosis plus concrete suggested edits referencing specific step indices; the postmortem is generated once and cached on the run.

### US-7 — Run history
**As a** user **I can** review my past runs
**Acceptance:** list per mission showing status, timestamp, ticks, distance; selecting a run replays it exactly.

## 7. Failure classes to detect

The product's core value is catching these before a robot does:

| Code | Meaning |
|---|---|
| `UNKNOWN_STATION` | Step references a station not in the layout |
| `UNREACHABLE` | No path exists to the target, given obstacles |
| `GRIPPER_FULL` | Pick while already carrying |
| `GRIPPER_EMPTY` | Place with nothing carried |
| `ITEM_NOT_PRESENT` | Pick an item that isn't at that station |
| `WRONG_STATION_KIND` | Charge at a non-charger, pick at a dock, etc. |
| `BATTERY_DEPLETED` | Battery reaches zero mid-mission |

## 8. Success criteria

**Product:** a first-time user goes from empty state to a completed simulated run in under three minutes, without documentation.

**Project (the one that's actually graded):** deployed and publicly reachable, all seven user stories demonstrable, unit and E2E suites green in CI, submitted 15.09.2026.

## 9. Open questions

- Should layouts be shareable read-only via URL? *Deferred — post-v1, not in scope for submission.*
- Item modelling: are items typed, or is any string accepted at a shelf? *v1: any string, presence tracked per station.*
