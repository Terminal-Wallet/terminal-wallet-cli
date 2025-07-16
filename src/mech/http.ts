import { createServer, Server } from "http";
import { AddressInfo } from "net";

function listenAsync(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

export const startHttpServer = async () => {
  const server: Server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          const jsonBody = JSON.parse(body);
          console.log("HTTP Server received POST request:");
          console.log(JSON.stringify(jsonBody, null, 2));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ status: "success", message: "Request logged" }),
          );
        } catch (error) {
          console.log("HTTP Server received invalid JSON:", body);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", message: "Invalid JSON" }));
        }
      });
    } else {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "error", message: "Method not allowed" }),
      );
    }
  });

  // Find an open port using a for loop, up to a maximum
  const findOpenPort = async (
    startPort: number,
    maxPort: number,
  ): Promise<number> => {
    for (let port = startPort; port <= maxPort; port++) {
      try {
        await listenAsync(server, port);
        server.close();
        return port;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          throw err;
        }
        // else, try next port
      }
    }
    throw new Error(`No open port found between ${startPort} and ${maxPort}`);
  };

  try {
    const startPort = 6100;
    const maxPort = 6200;
    const port = await findOpenPort(startPort, maxPort);
    await listenAsync(server, port);
    console.log(`Pilot Connect server running on port ${port}`);
    return port;
  } catch (error) {
    console.error("Failed to start HTTP server:", error);
    throw error;
  }
};
