/**
 * A relay that a stranger cannot kill.
 *
 * Node rethrows an 'error' event nobody is listening for, and `ws` emits one
 * for any frame it cannot parse. That put the lifetime of the process — and of
 * every room in it — in the hands of anyone who could open a socket, before a
 * token was ever consulted. The token guards the room; it never guarded the
 * building, because the frame fails to parse long before application code runs.
 *
 * These send the bytes rather than calling the handler, because the bug lived
 * in the gap between `ws` and us: a test that invoked our own code would have
 * passed throughout.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { startServer, type Relay } from "../src/server.js";

let relay: Relay;
let port: number;

/** Complete a real handshake, then hand back the raw socket to misbehave on. */
function upgraded(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        "GET / HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    socket.once("error", reject);
    socket.on("data", function onData(chunk: Buffer) {
      if (chunk.toString().includes("101")) {
        socket.removeListener("data", onData);
        resolve(socket);
      }
    });
  });
}

/** A client-masked frame, as the protocol requires of anything a client sends. */
function frame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

/** The relay is alive if it still answers an ordinary request. */
async function stillServing(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

describe("a stranger cannot take the relay down", () => {
  before(async () => {
    // A token is set precisely to show it is not what saves us: these frames
    // die in the parser, and the token is only read from a `message` handler
    // that never gets to run.
    relay = startServer({ port: 0, mode: "byo", host: "127.0.0.1", token: "test-token" });
    port = await relay.whenListening();
  });

  after(async () => {
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });

  test("a reserved close code does not end the process", async () => {
    const socket = await upgraded();
    // 1005 is reserved: it means "no status given" and may never be sent on
    // the wire. Two bytes, unauthenticated. This is the reported crash.
    socket.write(frame(0x8, Buffer.from([0x03, 0xed])));
    await new Promise((r) => setTimeout(r, 250));
    socket.destroy();
    assert.equal(await stillServing(), true);
  });

  test("an unknown opcode does not end the process", async () => {
    const socket = await upgraded();
    socket.write(frame(0x3, Buffer.from("nonsense")));
    await new Promise((r) => setTimeout(r, 250));
    socket.destroy();
    assert.equal(await stillServing(), true);
  });

  test("an unmasked client frame does not end the process", async () => {
    const socket = await upgraded();
    // Every client frame must be masked; an unmasked one is a protocol error.
    const payload = Buffer.from("unmasked");
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    await new Promise((r) => setTimeout(r, 250));
    socket.destroy();
    assert.equal(await stillServing(), true);
  });

  test("garbage that is not HTTP at all does not end the process", async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("\x16\x03\x01 not http\r\n\r\n");
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      });
      socket.on("error", () => resolve());
    });
    assert.equal(await stillServing(), true);
  });

  test("it survives a burst of them and still serves a good client", async () => {
    for (let i = 0; i < 25; i++) {
      const socket = await upgraded();
      socket.write(frame(0x8, Buffer.from([0x03, 0xed])));
      socket.destroy();
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await stillServing(), true);
    // And a well-behaved connection afterwards is unaffected by any of it.
    const good = await upgraded();
    assert.equal(good.destroyed, false);
    good.destroy();
  });
});

describe("a tokenless relay is not open to the browser", () => {
  let solo: Relay;
  let soloPort: number;

  before(async () => {
    // As the extension starts it for solo mode: loopback, no token.
    solo = startServer({ port: 0, mode: "byo", host: "127.0.0.1", denyBrowserOrigins: true });
    soloPort = await solo.whenListening();
  });

  after(async () => {
    await new Promise<void>((resolve) => solo.close(() => resolve()));
  });

  /** Handshake with an explicit Origin, as every browser does. */
  function handshake(origin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(soloPort, "127.0.0.1", () => {
        socket.write(
          "GET / HTTP/1.1\r\n" +
            `Host: 127.0.0.1:${soloPort}\r\n` +
            "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
            (origin ? `Origin: ${origin}\r\n` : "") +
            `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n"
        );
      });
      socket.once("error", reject);
      socket.once("data", (chunk: Buffer) => {
        socket.destroy();
        resolve(chunk.toString().split("\r\n")[0] ?? "");
      });
    });
  }

  test("a web page you happen to be visiting is refused", async () => {
    assert.match(await handshake("https://example.com"), /401|403/);
  });

  test("a page served from localhost is refused too", async () => {
    // Nothing legitimate reaches a solo relay from a browser, including a dev
    // server on the same machine.
    assert.match(await handshake("http://localhost:3000"), /401|403/);
  });

  test("the editor, which sends no Origin, still connects", async () => {
    assert.match(await handshake(undefined), /101/);
  });
});
