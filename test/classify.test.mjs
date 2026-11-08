import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../dist/index.js";

const cases = [
  // [error fields, outcome, reason, fallback]
  [{ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }, "not_sent", "auth", true],
  [{ code: "EDNS", command: "CONN", message: "getaddrinfo ENOTFOUND x" }, "not_sent", "connection", true],
  [{ code: "ESOCKET", command: "CONN", originalCode: "ECONNREFUSED" }, "not_sent", "connection", true],
  [{ code: "ESOCKET", command: "CONN", message: "connect ECONNREFUSED 1.2.3.4:587" }, "not_sent", "connection", true],
  [{ code: "ECONNREFUSED" }, "not_sent", "connection", true],
  [{ code: "ETIMEDOUT", command: "CONN", timeoutType: "CONNECT_TIMEOUT", message: "Connection timeout" }, "not_sent", "connection", true],
  [{ code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" }, "not_sent", "connection", true],
  [{ code: "ECONNECTION", command: "EHLO", message: "Server terminates connection" }, "not_sent", "connection", true],
  // The same code and command as a connect timeout, but it can happen after the body.
  [{ code: "ETIMEDOUT", command: "CONN", timeoutType: "SOCKET_TIMEOUT", message: "Timeout" }, "unknown", "timeout", false],
  [{ code: "ETIMEDOUT", command: "CONN", message: "Timeout" }, "unknown", "timeout", false],
  [{ code: "ECONNECTION", command: "CONN", message: "Connection closed unexpectedly" }, "unknown", "timeout", false],
  [{ code: "ESOCKET", command: "CONN", originalCode: "ECONNRESET", message: "read ECONNRESET" }, "unknown", "timeout", false],
  [{}, "unknown", "timeout", false],
  [new Error("something else"), "unknown", "timeout", false],
  // Server answers.
  [{ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550, response: "550 Sender not verified" }, "not_sent", "sender_rejected", true],
  [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 550, response: "550 5.1.1 No such user" }, "not_sent", "recipient_rejected", false],
  [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 552, response: "552 5.2.2 Mailbox over quota" }, "not_sent", "recipient_rejected", false],
  [{ code: "EENVELOPE", command: "RCPT TO", responseCode: 452, response: "452 4.2.2 Mailbox full" }, "not_sent", "recipient_rejected", false],
  [{ code: "EENVELOPE", command: "MAIL FROM", responseCode: 452, response: "452 Daily sending quota exceeded" }, "not_sent", "quota", true],
  [{ code: "EMESSAGE", command: "DATA", responseCode: 550, response: "550 Monthly email credits used up" }, "not_sent", "quota", true],
  [{ command: "MAIL FROM", responseCode: 421, response: "421 Too many connections, slow down" }, "not_sent", "rate_limited", true],
  [{ command: "DATA", responseCode: 451, response: "451 Temporary local problem" }, "not_sent", "provider_error", true],
  [{ code: "EMESSAGE", command: "DATA", responseCode: 554, response: "554 5.7.1 Message rejected as spam" }, "not_sent", "message_rejected", false],
  [{ code: "EMESSAGE", command: "DATA", responseCode: 552, response: "552 Message too large" }, "not_sent", "message_rejected", true],
  [{ code: "EMESSAGE", message: "No recipients defined" }, "not_sent", "invalid_message", false],
];

test("classify sorts transport errors", () => {
  for (const [fields, outcome, reason, fallback] of cases) {
    assert.deepEqual(classify(fields), { outcome, reason, fallback }, JSON.stringify(fields));
  }
});
