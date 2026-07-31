/**
 * A room for one, with nothing to set up.
 *
 * The first thing a stranger hit was infrastructure: deploy a relay, mint a
 * token, put it in settings, then find a second person. For an open-source
 * project that is the whole audience gone before the interesting part. So when
 * no relay is configured, the extension runs one itself, on the loopback
 * interface, for as long as the window is open.
 *
 * It is the same relay — same rooms, same transcript, same tool routing, same
 * action log — not a reduced imitation. That matters: solo mode is where people
 * form their opinion of the product, and a cut-down version would teach them the
 * wrong thing about it. Adding a second person later is a change of URL, not a
 * change of model.
 */

import { startServer, type Relay } from "@mpa/relay";

/**
 * A relay bound to loopback on an ephemeral port.
 *
 * No token: nothing outside this machine can reach 127.0.0.1, and demanding one
 * from a person talking to their own editor would be ceremony rather than
 * security. The relay warns when it is open *and* externally reachable, which
 * this is not.
 */
export class SoloRelay {
  private relay: Relay | undefined;
  private url: string | undefined;

  /** Start if not already running, and return the URL to connect to. */
  async start(dataDir: string): Promise<string> {
    if (this.url) return this.url;

    this.relay = startServer({
      port: 0,
      mode: "byo",
      host: "127.0.0.1",
      // History still persists, so a solo room survives a window reload. The
      // whole point is that it behaves like the real thing.
      dataDir,
    });

    const port = await this.relay.whenListening();
    this.url = `ws://127.0.0.1:${port}`;
    return this.url;
  }

  get address(): string | undefined {
    return this.url;
  }

  /** Flush history before the window goes, then stop. */
  async stop(): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    this.relay = undefined;
    this.url = undefined;
    await relay.flush().catch(() => undefined);
    for (const client of relay.clients) client.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
}
