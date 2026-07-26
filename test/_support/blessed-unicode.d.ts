/**
 * blessed ships no types for its width tables. Declared here, in the test
 * support tree rather than in `src/types`, because `src` no longer touches
 * them — chrome-width.test.ts asserts exactly that, and a declaration sitting
 * in src would invite the import back.
 */
declare module "blessed/lib/unicode" {
  const unicode: {
    charWidth(str: string | number, i?: number): number;
    strWidth(str: string): number;
    codePointAt(str: string, i?: number): number;
  };
  export default unicode;
}
