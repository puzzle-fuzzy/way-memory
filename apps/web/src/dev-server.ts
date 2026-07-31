const port = Number(Bun.env.WEB_PORT ?? 3412);
const root = new URL("../public/", import.meta.url);

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(new URL(requested, root));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`way-memory web listening on ${server.url}`);
