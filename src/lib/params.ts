/**
 * Safely extracts a single string parameter from Express 5 req.params or req.query.
 * Handles string, string[], or undefined values safely.
 */
export function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] ?? "";
  return param ?? "";
}

