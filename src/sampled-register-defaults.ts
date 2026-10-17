/**
 * Provider-neutral default size for the sampled traffic register. Keep this
 * literal in a zero-import leaf so local consumers such as help and gaps do
 * not load the sampled-session provider graph for a default value.
 */
export const DEFAULT_SAMPLED_REGISTER_SIZE = 50;
