---
description: Explicitly confirm and close a ready workflow change
---

This command is the user's explicit closure signal. First call `workflow_state` with `operation: "status"` and `change_id: "$ARGUMENTS"`. Only if the returned state is `ready`, call `workflow_state` with `operation: "complete"`, the exact returned `expected_version`, and `confirmation: "explicit_user_confirmation"`. If the state is active, explain that the change must reach ready first. Never close an active change merely because its implementation appears finished.
