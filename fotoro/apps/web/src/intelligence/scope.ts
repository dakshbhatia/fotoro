const scopes = new WeakMap<object, string>();
export function intelligenceScope(token: object): string {
  let scope = scopes.get(token);
  if (!scope) {scope = crypto.randomUUID(); scopes.set(token, scope);}
  return scope;
}
