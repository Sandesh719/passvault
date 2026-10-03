/// <reference types="vite/client" />

// Vite turns these into URLs at build time; the wasm one is how sql.js is
// told where to fetch its runtime from inside the Android asset bundle.
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
