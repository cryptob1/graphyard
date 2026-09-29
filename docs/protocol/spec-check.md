<!-- page: Agent protocol | 7 | the spec check on create, requirements and release. -->
# The spec check

Most rework starts in the task spec, not the code: an item whose criteria name a route or symbol that lives outside its `plannedFiles` sends its worker to build the wrong file. Before an intent is recorded or an item is released, its spec is graded against the base branch's tree: every repository path, route and exported symbol a criterion names must resolve — by `git grep` of the base — to a file `plannedFiles` covers, or one a criterion describes creating, and every criterion must carry at least one proof.

`master create` and `master requirements` refuse a failing intent before anything is recorded; `master release` refuses the same way before the item is made ready. The refusal names each unresolved reference with its criterion, so `master requirements` rewrites the spec mechanically: plan the file that holds each reference, or state in a criterion that the item creates it. An item authored before the check shipped is refused identically on release; the refusal is its fix list.

The same three rules are the terms every task-writing prompt carries (triage, research, review follow-ups): locate each planned file by searching for every symbol and route the criteria name; write one observable behaviour per criterion with its test; keep an item to at most 6 planned files, splitting larger work into dependent items. The check gates the CLI paths; the dashboard's release button is not gated by it and is left to a follow-up.
