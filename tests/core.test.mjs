import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../htdocs/luci-static/resources/live-traffic/core.js", import.meta.url),
  "utf8",
);

let now = 1_000_000;
const NativeDate = Date;
class FakeDate extends NativeDate {
  static now() {
    return now;
  }
}

const sandbox = {
  Date: FakeDate,
  String,
  Number,
  Object,
  Array,
  Math,
  console,
  baseclass: {
    extend: (members) => {
      function LiveTrafficCore() {}
      Object.assign(LiveTrafficCore.prototype, members);
      return LiveTrafficCore;
    },
  },
  rpc: { declare: () => () => Promise.resolve({}) },
  _: (value) => value,
  window: {
    devicePixelRatio: 1,
    getComputedStyle: () => ({ color: "#ffffff" }),
  },
  document: {},
  L: {},
};

const Core = vm.runInNewContext("(function () {" + source + "\n})()", sandbox);
const core = new Core();

test("exports a LuCI class constructor", () => {
  assert.equal(typeof Core, "function");
  assert.equal(typeof core.Monitor, "function");
  assert.equal(core.projectTitle, "LALT - luci-app-live-traffic");
});

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

test("reserves space for rate labels and renders responsive time ticks", () => {
  const labels = [];
  const moves = [];
  const context = {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo(x, y) { moves.push({ x, y }); },
    lineTo() {},
    stroke() {},
    fillText(text, x, y) { labels.push({ text, x, y }); },
    measureText(text) { return { width: String(text).length * 7 }; },
  };
  const canvas = {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: 1000, height: 190 }),
    getContext: () => context,
  };

  core.drawChart(canvas, [
    { t: 1_000, down: 125_000, up: 62_500 },
    { t: 1_600, down: 250_000, up: 125_000 },
  ]);

  assert.equal(labels.filter((label) => label.y === 184).length, 5);
  assert.ok(moves[0].x > 80);
});
