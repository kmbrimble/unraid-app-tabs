#!/bin/bash
# App Tabs console: one terminal connection into a container. Started by the host's ttyd for each browser connection:
#   console-attach.sh <docker> <container> <tmux-session or ""> <shell: sh|bash>
#
# Why this exists: `docker exec -it` leaves its process running inside the container when the client goes away (killing
# the docker CLI, in any signal, does not end it). For a shell that is a stray process; for `tmux attach` it is a stray
# tmux CLIENT, and tmux sizes a window to its smallest client, so every closed browser tab would leave a ghost that can
# shrink the real session. So each connection is tagged with a random id in the process environment, and when the
# connection ends (ttyd sends SIGHUP to this script, and the pty hang-up reaches it too) the container is asked to end
# exactly the processes carrying that id.
#
# Nothing here is ever interpolated into a shell string: values arrive as separate arguments, are re-validated against
# the same rules as the PHP side, and are passed on as separate arguments.

docker=$1 container=$2 session=$3 shell=$4

ident='^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
if [[ ! -x $docker || ! $container =~ $ident || ( -n $session && ! $session =~ $ident ) || ( $shell != sh && $shell != bash ) ]]; then
  echo "App Tabs: refusing to start: invalid container, session or shell." >&2
  exit 64
fi

id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null) || id="$$-$RANDOM-$RANDOM-$SECONDS"

cleanup() {
  # SIGHUP, not TERM: an interactive shell ignores TERM. The id is an argument (not in this process's environment), so the
  # scan never matches itself.
  "$docker" exec "$container" sh -c 'for d in /proc/[0-9]*; do
    if tr "\0" "\n" < "$d/environ" 2>/dev/null | grep -qx "APPTABS_CONN=$1"; then
      # A tmux server first started from a shell tab inherits the tag; it belongs to nobody and must outlive the tab.
      case "$(cat "$d/comm" 2>/dev/null)" in "tmux: server") continue ;; esac
      kill -HUP "${d#/proc/}" 2>/dev/null
    fi
  done' sh "$id" >/dev/null 2>&1
}

if [[ -n $session ]]; then
  cmd=(tmux attach-session -t "=$session")    # "=" matches the session name exactly, not as a prefix
else
  cmd=("$shell")
fi

trap 'cleanup; exit 0' HUP TERM INT
"$docker" exec -it -e "APPTABS_CONN=$id" "$container" "${cmd[@]}" <&0 &
child=$!
wait "$child"
rc=$?
cleanup    # a normal exit (the user detached): nothing carries the id any more, this is a cheap no-op
exit "$rc"
