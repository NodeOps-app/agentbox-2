// Backend error strings a route maps to a specific status. Kept free of imports:
// a route that pulled them from a backend slice would bundle @agentbox/relay (and
// its dynamic cloud-provider imports) into the Next route, which cannot resolve them.

/** A host without tmux cannot run a hub manager at all: 503, not a bad request. */
export const TMUX_MISSING =
  'tmux is not installed on the hub host; a hub-run manager lives in a tmux session (brew install tmux)';
