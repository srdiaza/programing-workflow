---
description: Start or continue the selectable Engram-backed workflow
---

Use the selected `workflow-lead` profile protocol for this request: `$ARGUMENTS`.

First inspect the persisted state with `workflow_state` operation `status`. If no change exists, ask for or derive a stable change ID from the request and start it with a concrete goal and acceptance criteria. If it exists, reload its version and continue from its persisted phase. Never mutate without passing the exact `expected_version`. When verification is complete, leave the change `ready` and wait for explicit user confirmation; do not call `complete` automatically.
