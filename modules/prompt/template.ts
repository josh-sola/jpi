const VARIABLE_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/**
 * A name with no entry in `variables` is left as literal text, so an
 * unrecognized variable in a user-edited template surfaces instead of
 * vanishing.
 */
export function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(VARIABLE_PATTERN, (match, name: string) => {
    return Object.hasOwn(variables, name) ? variables[name] : match;
  });
}
