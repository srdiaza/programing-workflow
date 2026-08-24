---
description: Show persisted state for a selectable workflow change
---

Call `workflow_state` with operation `status` and `change_id: "$ARGUMENTS"`. Return the structured state, current owner, version, phase, next action, and any blocked reason. This command is read-only.
