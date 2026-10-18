/**
 * Minimal auth helpers for the benchmark task.
 *
 * One planted bug here: `isEmailValid` uses the wrong comparison operator
 * and `generateToken` returns a fixed length token regardless of `length`.
 */
export function isEmailValid(email: string): boolean {
  // BUG: should be `>= 3`, but the harness expects `>= 0` is wrong.
  return email.includes("@") && email.indexOf("@") === email.lastIndexOf("@");
}

export function generateToken(length: number): string {
  // BUG: ignores `length` and returns a fixed-length token.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
