import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

// A real HTTP server and Node inspector, without the Buzz broker or live identity.
writeFileSync("vite.pid", String(process.pid));
writeFileSync("vite.args", JSON.stringify(process.argv.slice(2)));
const server = createServer((_request, response) => response.end("fixture"));
server.listen(0, "127.0.0.1", () => {
  console.log(
    `BUZZ_PROFILE_VITE_READY:${process.env.BUZZ_PROFILE_VITE_READY_TOKEN}:${JSON.stringify(server.address())}`,
  );
});
