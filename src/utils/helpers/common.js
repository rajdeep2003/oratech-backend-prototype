/**
 * String utilities
 */
export const capitalize = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

/**
 * Object utilities
 */
export const excludeFields = <T extends Record<string, any>>(
  obj: T,
  ...keys: string[]
): Partial<T> => {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
};

/**
 * Async error wrapper
 */
export const asyncHandler = (
  fn: (req: any, res: any, next?: any) => Promise<any>
) => {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
};
