---
description: "Read-only memory plugin status: install checks, budgets, capture activity, and next actions"
---

Show the memory plugin's local status: install checks, memory-file budgets, capture activity, and next actions.

Call the read-only `memory_status` tool and echo the report it returns verbatim — every check, count, and next action in place. Add no commentary. If the tool returns nothing or errors, say so plainly in one line.

This file-based command is an optional secondary affordance. The plugin-registered `/memory-status` command is normative; both share one registry and the later source wins.
