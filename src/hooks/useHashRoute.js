// Routing moved to clean paths (src/lib/routes.js + src/hooks/useRoute.js). `parseRoute` is still
// exported from here because it also accepts the old "#..." form, which existing tests check.
export { parseRoute } from '../lib/routes.js'
