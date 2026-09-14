#!/bin/sh
# Default-off `df` shim, installed only when the WITH_SLOW_DF build arg is true. It signals that
# it has started (an *observable* marker, never a fixed clock) then blocks, then execs the real
# `df` so an un-triggered scenario degrades into a slow pass, never a hang. This is the
# deterministic trigger for the mid-exec CONNECTION_LOST scenario (plan 02-10): a caller that has
# observed the marker file knows the remote `df` is blocked inside its sleep with no output sent
# yet, so killing the connection at that point lands mid-exec with a large timing margin.
#
# Writes nothing to stdout or stderr before the sleep — the scenario this exists for is a channel
# that has produced no output at all when the transport dies.
set -eu
touch /tmp/noodara-slow-df-started
sleep 20
exec /usr/bin/df "$@"
