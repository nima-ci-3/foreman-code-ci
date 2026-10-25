// Worker bundle publication timing, shared by the publisher script (which installed releases run without the
// contracts build) and the Worker update contracts.

/** Publication retries share one deadline from when publication becomes pending. */
export const WORKER_PUBLICATION_DEADLINE_MS = 2 * 60 * 60_000
