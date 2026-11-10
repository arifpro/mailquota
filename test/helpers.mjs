import net from "node:net";

/** A fake transport factory. `behaviors[accountId]` is a function called per send. */
export function fakeTransports(behaviors = {}) {
  const sent = [];
  const createTransport = (_options, account) => ({
    async sendMail(message) {
      const behavior = behaviors[account.id];
      if (behavior) {
        const outcome = await behavior(message);
        if (outcome) return outcome;
      }
      sent.push({ accountId: account.id, message });
      return { messageId: `<${sent.length}@${account.id}>`, accepted: [message.to], rejected: [] };
    },
    async verify() {
      return true;
    },
    close() {},
  });
  return { createTransport, sent };
}

/** An error shaped like the ones nodemailer throws. */
export function smtpError(fields) {
  return Object.assign(new Error(fields.response ?? fields.code ?? "smtp error"), fields);
}

export function clock(start = Date.UTC(2026, 10, 10, 12, 0, 0)) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => {
    now += ms;
  };
  fn.set = (ms) => {
    now = ms;
  };
  return fn;
}

export const account = (id, extra = {}) => ({
  id,
  smtp: { host: "smtp.example.test" },
  auth: { user: "u", pass: "p" },
  from: `no-reply@${id}.example.test`,
  ...extra,
});

/**
 * A minimal plain-text SMTP server for tests. `script` sets the reply per command:
 * { auth, mailFrom, rcptTo, data, hangOnData }.
 */
export function smtpServer(script = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    let inData = false;
    let body = "";
    let authStep = 0;
    const reply = (line) => socket.write(`${line}\r\n`);
    reply("220 test ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            if (script.hangOnData) return;
            if (script.data) reply(script.data);
            else {
              received.push(body);
              reply("250 2.0.0 queued as TEST1");
            }
            body = "";
          } else body += `${line}\n`;
          continue;
        }
        if (authStep > 0) {
          authStep--;
          if (authStep > 0) reply("334 UGFzc3dvcmQ6");
          else reply(script.auth ?? "235 2.7.0 ok");
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO")) {
          socket.write("250-test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) reply(script.auth ?? "235 2.7.0 ok");
        else if (upper.startsWith("AUTH LOGIN")) {
          authStep = 2;
          reply("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("MAIL FROM")) reply(script.mailFrom ?? "250 ok");
        else if (upper.startsWith("RCPT TO")) reply(script.rcptTo ?? "250 ok");
        else if (upper === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (upper === "RSET") reply("250 ok");
        else if (upper === "QUIT") {
          reply("221 bye");
          socket.end();
        } else reply("250 ok");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        received,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
