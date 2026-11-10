#!/bin/sh
# Claude Code statusLine: saves plan rate limits for Dev Dashboard and prints a short usage line.
f="$HOME/.claude/dev-dashboard-usage.json"
in=$(cat)
printf '%s' "$in" | jq -c '{seen_at: now, keys: keys, rate_limits: (.rate_limits != null)}' > "$HOME/.claude/dev-dashboard-statusline.last" 2>/dev/null # diagnostics: was I called, did I get limits?
snap=$(printf '%s' "$in" | jq -c 'select(.rate_limits != null) | {rate_limits, saved_at: now}' 2>/dev/null)
[ -n "$snap" ] && printf '%s' "$snap" > "$f.tmp" && mv "$f.tmp" "$f"
printf '%s' "$in" | jq -r '.rate_limits // empty | [(.five_hour // empty | "5h \(.used_percentage | floor)%"), (.seven_day // empty | "7d \(.used_percentage | floor)%")] | join(" · ")' 2>/dev/null
