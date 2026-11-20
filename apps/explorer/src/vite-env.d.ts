declare module "*.css";
/** A file's text, bundled at build (Vite ?raw). */
declare module "*?raw" {
  const text: string;
  export default text;
}
