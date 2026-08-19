#!/usr/bin/env ucode

'use strict';

import * as fs from 'fs';
import * as math from 'math';
import { cursor } from 'uci';
import { connect } from 'ubus';

const VALID_INTERVALS = [ 1, 2, 5, 10 ];
const ubus = connect();

function run(command) {
	let pipe = fs.popen(command + ' 2>/dev/null', 'r');
	if (!pipe)
		return null;

	let output = pipe.read('all');
	pipe.close();
	return output;
}

function field_index(columns, name) {
	for (let i = 0; i < length(columns); i++)
		if (columns[i] == name)
			return i;

	return -1;
}

function valid_interval(interval) {
	for (let candidate in VALID_INTERVALS)
		if (candidate == interval)
			return true;

	return false;
}

function ipv4_number(address) {
	let parts = split(address ?? '', '.');
	if (length(parts) != 4)
		return null;

	let value = 0;
	for (let part in parts) {
		let octet = int(part);
		if (octet < 0 || octet > 255)
			return null;
		value = value * 256 + octet;
	}

	return value;
}

function ipv4_in_subnet(address, subnet, mask) {
	let host = ipv4_number(address);
	let network = ipv4_number(subnet);
	let bits = int(mask);
	if (host == null || network == null || bits < 0 || bits > 32)
		return false;

	let divisor = math.pow(2, 32 - bits);
	return int(host / divisor) == int(network / divisor);
}

function network_state() {
	let wan = ubus.call('network.interface.wan', 'status', {}) ?? {};
	let lan = ubus.call('network.interface.lan', 'status', {}) ?? {};
	let devices = ubus.call('network.device', 'status', {}) ?? {};
	let wan_device = wan.l3_device ?? wan.device ?? 'wan';
	let stats = devices[wan_device]?.statistics ?? {};
	let subnets = [];

	for (let item in (lan['ipv4-address'] ?? []))
		push(subnets, { address: item.address, mask: item.mask });

	return {
		wan_device,
		wan_up: wan.up == true,
		wan_rx_bytes: stats.rx_bytes ?? 0,
		wan_tx_bytes: stats.tx_bytes ?? 0,
		lan_subnets: subnets,
	};
}

function traffic_rows(subnets) {
	let raw = run('/usr/sbin/nlbw -c json -g family,mac,ip -o mac,ip');
	if (!raw)
		return { error: 'NLBW_UNAVAILABLE', clients: [] };

	let payload;
	try {
		payload = json(raw);
	}
	catch (e) {
		return { error: 'NLBW_INVALID_JSON', clients: [] };
	}

	let columns = payload?.columns ?? [];
	let indexes = {
		family: field_index(columns, 'family'),
		mac: field_index(columns, 'mac'),
		ip: field_index(columns, 'ip'),
		conns: field_index(columns, 'conns'),
		rx_bytes: field_index(columns, 'rx_bytes'),
		rx_pkts: field_index(columns, 'rx_pkts'),
		tx_bytes: field_index(columns, 'tx_bytes'),
		tx_pkts: field_index(columns, 'tx_pkts'),
	};

	for (let key, value in indexes)
		if (value < 0)
			return { error: 'NLBW_MISSING_COLUMN_' + key, clients: [] };

	let clients = [];
	for (let row in (payload?.data ?? [])) {
		let family = row[indexes.family];
		let ip = row[indexes.ip];
		let local = family != 4;

		if (family == 4) {
			local = false;
			for (let subnet in subnets) {
				if (ipv4_in_subnet(ip, subnet.address, subnet.mask)) {
					local = true;
					break;
				}
			}
		}

		if (!local)
			continue;

		push(clients, {
			family,
			mac: row[indexes.mac] ?? '',
			ip,
			connections: row[indexes.conns] ?? 0,
			rx_bytes: row[indexes.rx_bytes] ?? 0,
			rx_packets: row[indexes.rx_pkts] ?? 0,
			tx_bytes: row[indexes.tx_bytes] ?? 0,
			tx_packets: row[indexes.tx_pkts] ?? 0,
		});
	}

	return { error: null, clients };
}

function read_settings() {
	let uci = cursor();
	let interval = int(uci.get('live_traffic', 'main', 'interval') ?? 1);
	if (!valid_interval(interval))
		interval = 1;

	return {
		interval,
		retention_seconds: int(uci.get('live_traffic', 'main', 'retention_seconds') ?? 600),
		unit: uci.get('live_traffic', 'main', 'unit') ?? 'bits',
		managed_nlbwmon: uci.get('live_traffic', 'main', 'managed_nlbwmon') == '1',
		previous_refresh_interval: uci.get('live_traffic', 'main', 'previous_refresh_interval') ?? '',
		nlbwmon_refresh_interval: uci.get('nlbwmon', '@nlbwmon[0]', 'refresh_interval') ?? '30s',
		offload_software: uci.get('firewall', '@defaults[0]', 'flow_offloading') == '1',
		offload_hardware: uci.get('firewall', '@defaults[0]', 'flow_offloading_hw') == '1',
		nlbwmon_running: fs.access('/var/run/nlbwmon.sock') == true,
	};
}

function snapshot() {
	let network = network_state();
	let traffic = traffic_rows(network.lan_subnets);
	return {
		timestamp: time(),
		network,
		clients: traffic.clients,
		error: traffic.error,
		settings: read_settings(),
	};
}

function request_args(request) {
	if (type(request?.args) == 'object')
		return request.args;
	if (type(request) == 'object')
		return request;
	return {};
}

function configure(request) {
	let uci = cursor();
	let args = request_args(request);
	let interval = int(args.interval);
	if (!valid_interval(interval))
		return { error: 'INVALID_INTERVAL' };

	let current = uci.get('nlbwmon', '@nlbwmon[0]', 'refresh_interval') ?? '30s';
	let managed = uci.get('live_traffic', 'main', 'managed_nlbwmon') == '1';
	if (!managed) {
		uci.set('live_traffic', 'main', 'previous_refresh_interval', current);
		uci.set('live_traffic', 'main', 'managed_nlbwmon', '1');
	}

	uci.set('live_traffic', 'main', 'interval', '' + interval);
	uci.set('nlbwmon', '@nlbwmon[0]', 'refresh_interval', interval + 's');
	uci.commit('live_traffic');
	uci.commit('nlbwmon');
	run('/etc/init.d/nlbwmon reload');
	return { ok: true, settings: read_settings() };
}

function restore() {
	let uci = cursor();
	let managed = uci.get('live_traffic', 'main', 'managed_nlbwmon') == '1';
	if (!managed)
		return { ok: true, settings: read_settings() };

	let previous = uci.get('live_traffic', 'main', 'previous_refresh_interval') ?? '30s';
	let configured = int(uci.get('live_traffic', 'main', 'interval') ?? 1) + 's';
	let current = uci.get('nlbwmon', '@nlbwmon[0]', 'refresh_interval') ?? '30s';
	if (current != configured)
		return { error: 'NLBWMON_CONFIG_CHANGED', settings: read_settings() };

	uci.set('nlbwmon', '@nlbwmon[0]', 'refresh_interval', previous);
	uci.set('live_traffic', 'main', 'managed_nlbwmon', '0');
	uci.set('live_traffic', 'main', 'previous_refresh_interval', '');
	uci.commit('live_traffic');
	uci.commit('nlbwmon');
	run('/etc/init.d/nlbwmon reload');
	return { ok: true, settings: read_settings() };
}

const methods = {
	snapshot: { call: snapshot },
	settings: { call: read_settings },
	configure: { args: { interval: 1 }, call: configure },
	restore: { call: restore },
};

return { 'luci.live_traffic': methods };
