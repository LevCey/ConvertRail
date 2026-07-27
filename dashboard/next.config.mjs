/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,
  // The reference run is read at request time, so file tracing cannot infer
  // it from the import graph; include it explicitly or a deployed build shows
  // chain state with no payment or duplicate-refusal evidence beside it.
  outputFileTracingIncludes: {
    "/*": ["reference-run/**/*"],
  },
};

export default nextConfig;
