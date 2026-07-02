import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  extractNgrokError,
  extractNgrokTunnelUrl,
} from "../../../../src/services/capture/ngrok.js";

describe("extractNgrokTunnelUrl", () => {
  it("extracts the public URL from ngrok v3 JSON logs", () => {
    const out = [
      '{"lvl":"info","msg":"starting web service","addr":"127.0.0.1:4040"}',
      '{"addr":"http://localhost:3838","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","url":"https://truth-thriving-commodore.ngrok-free.dev"}',
    ].join("\n");

    assert.equal(
      extractNgrokTunnelUrl(out),
      "https://truth-thriving-commodore.ngrok-free.dev",
    );
  });

  it("supports static/custom ngrok URLs", () => {
    const out =
      '{"addr":"http://localhost:3838","lvl":"info","msg":"started tunnel","url":"https://capture.example.ngrok.app"}';

    assert.equal(extractNgrokTunnelUrl(out), "https://capture.example.ngrok.app");
  });

  it("does not return local API/status URLs from unrelated log lines", () => {
    const out = [
      '{"lvl":"info","msg":"starting web service","addr":"127.0.0.1:4040"}',
      '{"lvl":"info","msg":"client session established","obj":"tunnels.session"}',
    ].join("\n");

    assert.equal(extractNgrokTunnelUrl(out), undefined);
  });

  it("ignores partial/non-json output while waiting for the tunnel line", () => {
    const out = [
      "not json",
      '{"lvl":"info","msg":"started tunnel"',
      '{"addr":"http://localhost:3838","lvl":"info","msg":"started tunnel","url":"https://abc.ngrok-free.dev"}',
    ].join("\n");

    assert.equal(extractNgrokTunnelUrl(out), "https://abc.ngrok-free.dev");
  });
});

describe("extractNgrokError", () => {
  it("extracts duplicate-endpoint failures from ngrok JSON logs", () => {
    const out = [
      '{"lvl":"info","msg":"starting web service","addr":"127.0.0.1:4040"}',
      '{"err":"failed to start tunnel: The endpoint \\"https://truth-thriving-commodore.ngrok-free.dev\\" is already online.\\r\\n\\r\\nERR_NGROK_334\\r\\n","lvl":"crit","msg":"command failed"}',
    ].join("\n");

    const error = extractNgrokError(out);
    assert.equal(typeof error, "string");
    assert.match(error!, /already online/);
    assert.match(error!, /ERR_NGROK_334/);
  });

  it("ignores non-error and nil-error log lines", () => {
    const out = [
      '{"err":"<nil>","lvl":"info","msg":"open config file"}',
      '{"lvl":"info","msg":"client session established"}',
    ].join("\n");

    assert.equal(extractNgrokError(out), undefined);
  });
});
