---
description: Local usage metrics of the memory plugin (count-only, on-machine)
---

Show the memory plugin's local usage metrics. Every value is a count-only statistic of the plugin's own activity, stored and rendered entirely on this machine: no memory content, no prompt text, no tool output, no paths, no identities ever enter the table.

Call the read-only `memory_metrics` tool and echo the markdown table it returns verbatim, exactly as received — every count, name, and row in place. Counts only: do not paraphrase, summarize, reorder, or round any numbers, and add no commentary beyond the table (it is count-only plugin statistics). If the tool returns nothing or errors, say so plainly in one line.

This file-based command is an optional secondary affordance. The plugin-registered `/memory-metrics` command is normative; both share one registry and the later source wins.
