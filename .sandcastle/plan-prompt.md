# ISSUES

Here are the open issues in the repo:

<issues-json>

!`gh api 'repos/{owner}/{repo}/issues?state=open&labels=ready-for-agent&per_page=100' --jq '[.[] | select(.pull_request | not) | {number, title, body, labels: [.labels[].name], open_blockers: .issue_dependencies_summary.blocked_by}]'`

</issues-json>

The list above has already been filtered to issues labelled `ready-for-agent`.

`open_blockers` is the number of open issues GitHub records as blocking this one (native issue dependencies). An issue with `open_blockers > 0` is **blocked** — never include it in the plan.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

Beyond the recorded dependencies, an issue B is also **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the exact format `sandcastle/issue-{id}` (no slug or other suffix). This must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked issues. If every issue is blocked only by the overlap rules above, include the single highest-priority candidate (the one with the fewest or weakest dependencies). Never include an issue with `open_blockers > 0`.

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
