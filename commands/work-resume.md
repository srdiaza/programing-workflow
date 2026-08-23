---
description: Recover and resume a persisted selectable workflow change
agent: workflow-lead
---

Call `workflow_state` with operation `status` and `change_id: "$ARGUMENTS"`. If the owner lease is stale, call `recover` with the exact returned `expected_version`; otherwise continue as the current owner. Explain the recovered phase and next action before doing work.
