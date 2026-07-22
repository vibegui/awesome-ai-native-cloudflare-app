// wrangler.jsonc's `rules: [{ type: "Text", globs: ["**/*.md", "dist/web/*.html"] }]`
// imports these files as strings at build time. These declarations teach
// TypeScript the same thing.
declare module "*.html" {
  const text: string;
  export default text;
}

declare module "*.md" {
  const text: string;
  export default text;
}
