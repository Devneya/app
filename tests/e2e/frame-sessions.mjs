import { EventEmitter } from "node:events";

// Playwright's public CDPSession cannot address a flattened child session.
// This test-only adapter forwards Chromium's child-session messages unchanged.
export async function captureChildSessions(parent, configure, reportFailure) {
  const children = new Map();
  let nextId = 0;
  const received = ({ sessionId, message }) => {
    try {
      const child = children.get(sessionId);
      const packet = JSON.parse(message);
      if (!child) throw new Error(`Message for unknown child session ${sessionId}: ${message}`);
      if (packet.id !== undefined) {
        const call = child.calls.get(packet.id);
        if (!call) throw new Error(`Unmatched child command response: ${message}`);
        child.calls.delete(packet.id);
        if (packet.error) {
          const error = new Error(`${call.method}: ${packet.error.message}`);
          error.cause = packet.error;
          call.reject(error);
        } else call.resolve(packet.result);
      } else child.session.emit(packet.method, packet.params);
    } catch (error) { reportFailure(error); }
  };
  const detached = ({ sessionId }) => {
    const child = children.get(sessionId);
    if (!child) return;
    for (const call of child.calls.values()) {
      call.reject(new Error(`${call.method}: child session detached before its result arrived`));
    }
    child.calls.clear();
    child.close();
    children.delete(sessionId);
  };
  const attached = ({ sessionId }) => {
    const session = new EventEmitter();
    const calls = new Map();
    session.send = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId;
      calls.set(id, { method, resolve, reject });
      parent.send("Target.sendMessageToTarget", {
        sessionId, message: JSON.stringify({ id, method, params }),
      }).catch(error => { calls.delete(id); reportFailure(error); reject(error); });
    });
    const child = { session, calls, close: () => {} };
    children.set(sessionId, child);
    // configure installs stream listeners synchronously, before enabling Network.
    child.close = configure(session);
  };
  parent.on("Target.receivedMessageFromTarget", received);
  parent.on("Target.attachedToTarget", attached);
  parent.on("Target.detachedFromTarget", detached);
  await parent.send("Target.setAutoAttach", {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: false,
    filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
  });
  return () => {
    for (const sessionId of children.keys()) detached({ sessionId });
    parent.off("Target.receivedMessageFromTarget", received);
    parent.off("Target.attachedToTarget", attached);
    parent.off("Target.detachedFromTarget", detached);
  };
}
