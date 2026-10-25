// `astro dev` in its own process, for tests where a dev server and a build
// share a project. Prints `port <n>` once listening; stops when stdin closes.
import { dev } from "astro";

const root = process.argv[2]!;
const server = await dev({ root, logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
process.stdout.write(`port ${server.address.port}\n`);
process.stdin.resume();
await new Promise((resolve) => process.stdin.on("end", resolve));
await server.stop();
process.exit(0);
