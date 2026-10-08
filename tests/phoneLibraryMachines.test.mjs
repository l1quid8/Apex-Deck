import test from "node:test";
import assert from "node:assert/strict";
import { listPhoneLibrary, phoneLibraryNote } from "../src/phone/libraryMachines.ts";

const picture = { file: "a.png", kind: "image", source: "chat", room: "t1", by: "Null", created: 100, path: "/lib/a.png" };
const fullAccess = { tier: "full", threads: "all" };
const denied = "The Library needs Full access to all threads on Work MacBook. Change this phone's access in Work MacBook's Settings → Paired devices.";

// A fake connection store: counts listeners so the tests can check each one was removed.
function fakeConnection(kind) {
  let status = { kind };
  const listeners = new Set();
  return {
    get: () => ({ status }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      status = { kind: next };
      for (const listener of [...listeners]) listener();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

// A fake backend whose libraryList counts each request it receives.
function fakeBackend(list = [picture]) {
  const backend = {
    requests: 0,
    libraryList: async () => {
      backend.requests += 1;
      return list;
    },
  };
  return backend;
}

function machine({ connection, backend, access = () => fullAccess }) {
  return { id: "m1", name: "Work MacBook", backend, connection, access };
}

test("a machine still connecting waits, then sends exactly one library_list once connected", async () => {
  const connection = fakeConnection("connecting");
  const backend = fakeBackend();
  const pending = listPhoneLibrary(machine({ connection, backend }), 1000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(backend.requests, 0);
  connection.set("connected");
  assert.deepEqual(await pending, [picture]);
  assert.equal(backend.requests, 1);
  assert.equal(connection.listeners, 0);
});

test("a connection that is already connected sends one request straight away", async () => {
  const connection = fakeConnection("connected");
  const backend = fakeBackend();
  assert.deepEqual(await listPhoneLibrary(machine({ connection, backend }), 1000), [picture]);
  assert.equal(backend.requests, 1);
});

test("restricted access after hello rejects with the Full access line and sends no request", async () => {
  for (const access of [{ tier: "chat", threads: "all" }, { tier: "full", threads: ["t1"] }, { tier: "read_only", threads: "all" }]) {
    const connection = fakeConnection("connected");
    const backend = fakeBackend();
    await assert.rejects(listPhoneLibrary(machine({ connection, backend, access: () => access }), 1000), (error) => {
      assert.equal(error.message, "needs Full access to all threads");
      return true;
    });
    assert.equal(backend.requests, 0);
    assert.equal(connection.listeners, 0);
  }
});

test("access is read after the connection is ready, not before", async () => {
  const connection = fakeConnection("connecting");
  const backend = fakeBackend();
  let reads = 0;
  const pending = listPhoneLibrary(machine({ connection, backend, access: () => (reads += 1, fullAccess) }), 1000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reads, 0);
  connection.set("connected");
  await pending;
  assert.equal(reads, 1);
  assert.equal(backend.requests, 1);
});

test("a machine that never connects times out and sends no request", async () => {
  const connection = fakeConnection("connecting");
  const backend = fakeBackend();
  await assert.rejects(listPhoneLibrary(machine({ connection, backend }), 20), /timed out/);
  assert.equal(backend.requests, 0);
  assert.equal(connection.listeners, 0);
});

test("a connection that fails rejects with not connected and unsubscribes", async () => {
  const connection = fakeConnection("connecting");
  const backend = fakeBackend();
  const pending = listPhoneLibrary(machine({ connection, backend }), 1000);
  connection.set("failed");
  await assert.rejects(pending, /not connected/);
  assert.equal(backend.requests, 0);
  assert.equal(connection.listeners, 0);
});

test("a request that fails rejects and unsubscribes", async () => {
  const connection = fakeConnection("connected");
  const backend = { libraryList: async () => { throw new Error("socket closed"); } };
  await assert.rejects(listPhoneLibrary(machine({ connection, backend }), 1000), /socket closed/);
  assert.equal(connection.listeners, 0);
});

test("a machine without access info (WebSocket) is not denied", async () => {
  const connection = fakeConnection("connected");
  const backend = fakeBackend();
  assert.deepEqual(await listPhoneLibrary(machine({ connection, backend, access: () => null }), 1000), [picture]);
  assert.equal(backend.requests, 1);
});

test("an offline or timed-out machine gets the offline note", () => {
  assert.equal(phoneLibraryNote("Work MacBook", new Error("timed out")), "Work MacBook offline. Its pictures show when it's back.");
  assert.equal(phoneLibraryNote("Work MacBook", new Error("not connected")), "Work MacBook offline. Its pictures show when it's back.");
});

test("an older daemon gets the old-daemon note", () => {
  assert.equal(
    phoneLibraryNote("Work MacBook", new Error("unknown variant `library_list`, expected one of ...")),
    "Work MacBook runs an older apex-daemon without a Library. Update it there to see its pictures.",
  );
});

test("a denied machine gets the Full access line", () => {
  assert.equal(phoneLibraryNote("Work MacBook", new Error("needs Full access to all threads")), denied);
  assert.equal(phoneLibraryNote("Work MacBook", new Error("device is not allowed to read the library")), denied);
});

test("any other failure shows its message under the machine name", () => {
  assert.equal(phoneLibraryNote("Work MacBook", new Error("socket closed")), "Couldn't load the Library from Work MacBook: socket closed");
});

test("a dropped in-flight connection gets the offline note", () => {
  assert.equal(phoneLibraryNote("Hetzner", new Error("The connection to the host was lost, so this may not have finished.")), "Hetzner offline. Its pictures show when it's back.");
});
