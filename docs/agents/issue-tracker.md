# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `lazymarcus005-maker/marcus-cli`. Because this workspace has no Git remote, pass `--repo lazymarcus005-maker/marcus-cli` to `gh` commands.

## Conventions

- **Create an issue**: `gh issue create --repo lazymarcus005-maker/marcus-cli --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo lazymarcus005-maker/marcus-cli --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo lazymarcus005-maker/marcus-cli --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo lazymarcus005-maker/marcus-cli --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo lazymarcus005-maker/marcus-cli --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo lazymarcus005-maker/marcus-cli --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents. GitHub shares one number space across issues and PRs, so a bare `#42` may be either; resolve it with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `lazymarcus005-maker/marcus-cli`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo lazymarcus005-maker/marcus-cli --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Child tickets are GitHub sub-issues where supported; otherwise add `Part of #<map>` to the child body. Use native GitHub issue dependencies where supported; otherwise record `Blocked by: #<n>, #<n>` at the top of the child body. The frontier is the first open, unassigned child without open blockers. Claim with `gh issue edit <n> --repo lazymarcus005-maker/marcus-cli --add-assignee @me`; resolve with a comment, close, and a context pointer on the map.
