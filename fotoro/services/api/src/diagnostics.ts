const methods = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"]);

export function diagnosticMethod(method: string): string {
  return methods.has(method) ? method : "OTHER";
}
