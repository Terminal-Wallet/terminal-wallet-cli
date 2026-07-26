declare module "blessed/lib/unicode" {
  const unicode: {
    charWidth(str: string | number, i?: number): number;
    strWidth(str: string): number;
    codePointAt(str: string, i?: number): number;
    combining: Record<number, boolean>;
  };
  export default unicode;
}
