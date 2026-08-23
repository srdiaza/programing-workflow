---
description: Recover and resume a persisted selectable workflow change
agent: workflow-lead
---

Call `workflow_state` with operation `status` and `change_id: "$ARGUMENTS"`. If the state is `ready` and the user requests another adjustment, call `reopen` with the exact returned `expected_version`; if the owner lease is stale for an active change, call `recover` with that version. Otherwise continue as the current owner. Explain the recovered phase and next action before doing work.
