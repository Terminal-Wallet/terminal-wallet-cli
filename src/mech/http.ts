import { createServer, Server } from "http";
import * as crypto from "crypto";
import { confirmPrompt } from "../ui/confirm-ui";

export interface MetaTransaction {
  to: string;
  value: string;
  data: string;
  operation: 0 | 1;
}

type TransactionRequestListener = (request: MetaTransaction[]) => void;

let transactionRequestListener: TransactionRequestListener | null = null;

export const onTransactionRequest = (listener: TransactionRequestListener) => {
  transactionRequestListener = listener;
};

let httpServerPort: number | undefined;
let secret: string | undefined;

function listenAsync(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

const startHttpServer = async () => {
  console.log("Starting Pilot callback server...");

  // Generate a random, URL-safe secret
  secret = crypto
    .createHash("sha256")
    .update(crypto.randomBytes(32).toString("hex"))
    .digest("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 16);

  const server: Server = createServer((req, res) => {
    if (req.method === "POST") {
      console.warn(
        "Pilot Connect server received request:",
        req.url,
        req.method,
      );
      // authenticate using the secret query parameter
      const secretParam = new URL(
        req.url || "",
        "http://localhost",
      ).searchParams.get("secret");

      if (secretParam !== secret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: "Wrong secret" }));
        return;
      }

      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        try {
          const jsonBody = JSON.parse(body);
          if (transactionRequestListener == null) {
            throw new Error("No transaction request listener");
          }
          transactionRequestListener(jsonBody);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ status: "success", message: "Request processed" }),
          );
        } catch (error) {
          console.error("Pilot Connect server received invalid JSON:", body);
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

  httpServerPort = await findOpenPort(6100, 6200);
  try {
    await listenAsync(server, httpServerPort);

    // Close server on Terminal shutdown
    process.on("SIGINT", () => {
      server.close(() => {
        process.exit(0);
      });
    });

    console.log(`Pilot Connect server running on port ${httpServerPort}`);
    return { port: httpServerPort, secret };
  } catch (error) {
    console.error("Failed to start Pilot Connect server:", error);
    throw error;
  }
};

export const ensureHttpServer = async () => {
  if (httpServerPort && secret) {
    return { port: httpServerPort, secret };
  }
  return await startHttpServer();
};
