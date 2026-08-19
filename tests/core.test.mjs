import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../htdocs/luci-static/resources/live-traffic/core.js", import.meta.url),
  "utf8",
);

let now = 1_000_000;
const sandbox = {
  Date: { now: () => now },
  String,
  Number,
  Object,
  Array,
  Math,
  console,
  rpc: { declare: () => () => Promise.resolve({}) },
  _: (value) => value,
  window: {},
  document: {},
  L: {},
};

const core = vm.runInNewContext("(function () {" + source + "\n})()", sandbox);

function snapshot(rxBytes, txBytes, wanRx = rxBytes, wanTx = txBytes) {
  return {
    clients: [{
      family: 4,
      mac: "AA:BB:CC:DD:EE:FF",
      ip: "192.168.5.10",
      connections: 3,
      rx_bytes: rxBytes,
      tx_bytes: txBytes,
    }],
    network: { wan_rx_bytes: wanRx, wan_tx_bytes: wanTx },
    settings: { retention_seconds: 600 },
  };
}

const leases = {
  dhcp_leases: [{
    macaddr: "aa:bb:cc:dd:ee:ff",
    ipaddr: "192.168.5.10",
    hostname: "phone",
  }],
};

test("computes per-device and WAN rates from counter deltas", () => {
  const monitor = new core.Monitor(600);
  monitor.ingest(snapshot(1000, 500), leases);
  now += 1000;
  const state = monitor.ingest(snapshot(3000, 1500), leases);
  assert.equal(state.devices[0].name, "phone");
  assert.equal(state.devices[0].downRate, 2000);
  assert.equal(state.devices[0].upRate, 1000);
  assert.equal(state.wan.downRate, 2000);
  assert.equal(state.wan.upRate, 1000);
});

test("treats counter resets as a new baseline", () => {
  const monitor = new core.Monitor(600);
  monitor.ingest(snapshot(9000, 8000), leases);
  now += 1000;
  const state = monitor.ingest(snapshot(100, 50), leases);
  assert.equal(state.devices[0].downRate, 0);
  assert.equal(state.devices[0].upRate, 0);
});

test("evicts samples outside the retention window", () => {
  const monitor = new core.Monitor(2);
  monitor.ingest(snapshot(1, 1), leases);
  now += 1000;
  monitor.ingest(snapshot(2, 2), leases);
  now += 2000;
  monitor.ingest(snapshot(3, 3), leases);
  assert.equal(monitor.samples("aa:bb:cc:dd:ee:ff").length, 2);
});

test("formats rates and byte totals", () => {
  assert.equal(core.formatRate(125000), "1.00 Mbit/s");
  assert.equal(core.formatBytes(1024), "1.00 KiB");
});
