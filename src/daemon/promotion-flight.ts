// Concern: the reasons a recorded promotion state names when the loop dispatches nothing (GY-1831's gate readings).

/** The reason control-plane mode reports when the loop's environment gives it no local release ports. */
export const noLocalPortsReason = 'The recorded merger is control-plane, so the loop cuts and promotes candidates itself, but its environment names no UAT: set GRAPHYARD_UAT_URL, GRAPHYARD_UAT_TOKEN and GRAPHYARD_PRODUCTION_URL for the loop';
/** What a recorded promotion reason starts with while the main watch's freeze holds every dispatch (GY-1831's gate reading). */
export const promotionFrozenReasonPrefix = 'Promotion is frozen since ';
/** The reason a recorded promotion state names while `run.promoteEveryMinutes` is 0 and nothing is ever dispatched (GY-1831's gate reading). */
export const promotionOffReason = 'Promotion by the loop is off (run.promoteEveryMinutes is 0)';
