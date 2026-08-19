'use strict';
'require baseclass';
'require rpc';

var callSnapshot = rpc.declare({
	object: 'luci.live_traffic',
	method: 'snapshot',
	expect: { '': {} }
});

var callSettings = rpc.declare({
	object: 'luci.live_traffic',
	method: 'settings',
	expect: { '': {} }
});

var callConfigure = rpc.declare({
	object: 'luci.live_traffic',
	method: 'configure',
	params: [ 'interval' ],
	expect: { '': {} }
});

var callRestore = rpc.declare({
	object: 'luci.live_traffic',
	method: 'restore',
	expect: { '': {} }
});

var callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

function normalizeMac(mac) {
	return String(mac || '').toLowerCase();
}

function leaseMap(payload) {
	var leases = {};

	Object.keys(payload || {}).forEach(function(key) {
		var values = Array.isArray(payload[key]) ? payload[key] : [];
		values.forEach(function(lease) {
			var mac = normalizeMac(lease.macaddr);
			if (!mac)
				return;

			if (!leases[mac])
				leases[mac] = { hostname: '', ips: [] };
			if (lease.hostname)
				leases[mac].hostname = lease.hostname;
			if (lease.ipaddr && leases[mac].ips.indexOf(lease.ipaddr) < 0)
				leases[mac].ips.push(lease.ipaddr);
		});
	});

	return leases;
}

function aggregateClients(rows, leasesPayload) {
	var known = leaseMap(leasesPayload);
	var clients = {};

	(rows || []).forEach(function(row) {
		var mac = normalizeMac(row.mac);
		var key = mac || 'unattributed';
		var client = clients[key];

		if (!client) {
			client = clients[key] = {
				key: key,
				mac: mac,
				name: '',
				ips: [],
				connections: 0,
				rxBytes: 0,
				txBytes: 0,
			};
		}

		if (row.ip && client.ips.indexOf(row.ip) < 0)
			client.ips.push(row.ip);
		client.connections += Number(row.connections) || 0;
		client.rxBytes += Number(row.rx_bytes) || 0;
		client.txBytes += Number(row.tx_bytes) || 0;
	});

	Object.keys(clients).forEach(function(key) {
		var client = clients[key];
		var lease = known[client.mac];
		if (lease) {
			client.name = lease.hostname || '';
			lease.ips.forEach(function(ip) {
				if (client.ips.indexOf(ip) < 0)
					client.ips.push(ip);
			});
		}

		if (!client.name)
			client.name = client.ips[0] || client.mac || _('Unattributed traffic');
	});

	return Object.keys(clients).map(function(key) {
		return clients[key];
	});
}

function Monitor(retentionSeconds) {
	this.retention = Number(retentionSeconds) || 600;
	this.previous = null;
	this.history = {};
	this.current = null;
}

Monitor.prototype.append = function(key, sample, now) {
	var values = this.history[key] || (this.history[key] = []);
	values.push({ t: now, down: sample.downRate, up: sample.upRate });

	var cutoff = now - this.retention;
	while (values.length && values[0].t < cutoff)
		values.shift();
};

Monitor.prototype.ingest = function(snapshot, leases) {
	var now = Date.now() / 1000;
	var previous = this.previous;
	var elapsed = previous ? Math.max(0.1, now - previous.now) : 0;
	var devices = aggregateClients(snapshot.clients, leases);
	var previousDevices = {};

	if (previous)
		previous.devices.forEach(function(device) {
			previousDevices[device.key] = device;
		});

	for (var i = 0; i < devices.length; i++) {
		var device = devices[i];
		var old = previousDevices[device.key];
		var rxDelta = old ? device.rxBytes - old.rxBytes : 0;
		var txDelta = old ? device.txBytes - old.txBytes : 0;
		device.downRate = elapsed && rxDelta >= 0 ? rxDelta / elapsed : 0;
		device.upRate = elapsed && txDelta >= 0 ? txDelta / elapsed : 0;
		this.append(device.key, device, now);
	}

	devices.sort(function(a, b) {
		return (b.downRate + b.upRate) - (a.downRate + a.upRate);
	});

	var network = snapshot.network || {};
	var wanRx = Number(network.wan_rx_bytes) || 0;
	var wanTx = Number(network.wan_tx_bytes) || 0;
	var oldWan = previous ? previous.wan : null;
	var wan = {
		rxBytes: wanRx,
		txBytes: wanTx,
		downRate: oldWan && wanRx >= oldWan.rxBytes ? (wanRx - oldWan.rxBytes) / elapsed : 0,
		upRate: oldWan && wanTx >= oldWan.txBytes ? (wanTx - oldWan.txBytes) / elapsed : 0,
	};
	this.append('__wan__', wan, now);

	this.current = {
		now: now,
		devices: devices,
		wan: wan,
		snapshot: snapshot,
	};
	this.previous = this.current;
	return this.current;
};

Monitor.prototype.samples = function(key) {
	return this.history[key] || [];
};

function formatNumber(value, suffixes, base) {
	var amount = Math.max(0, Number(value) || 0);
	var index = 0;
	while (amount >= base && index < suffixes.length - 1) {
		amount /= base;
		index++;
	}
	return (amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(2)) + ' ' + suffixes[index];
}

function formatRate(bytesPerSecond) {
	return formatNumber((Number(bytesPerSecond) || 0) * 8, [ 'bit/s', 'Kbit/s', 'Mbit/s', 'Gbit/s' ], 1000);
}

function formatBytes(bytes) {
	return formatNumber(bytes, [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ], 1024);
}

function formatChartTime(timestamp, span) {
	var options = {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	};
	if (span < 120)
		options.second = '2-digit';

	return new Date(timestamp * 1000).toLocaleTimeString([], options);
}

function drawChart(canvas, samples, options) {
	if (!canvas)
		return;

	var rect = canvas.getBoundingClientRect();
	var width = Math.max(280, Math.floor(rect.width || 600));
	var height = Math.max(110, Math.floor(rect.height || 180));
	var ratio = window.devicePixelRatio || 1;
	if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
		canvas.width = Math.floor(width * ratio);
		canvas.height = Math.floor(height * ratio);
	}

	var ctx = canvas.getContext('2d');
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, width, height);

	var style = window.getComputedStyle(canvas);
	var foreground = style.color || '#475569';
	var grid = 'rgba(127, 127, 127, 0.18)';
	var maximum = 1;

	(samples || []).forEach(function(sample) {
		maximum = Math.max(maximum, sample.down, sample.up);
	});

	ctx.font = '11px sans-serif';
	var widestRate = 0;
	for (var rateLine = 0; rateLine <= 3; rateLine++)
		widestRate = Math.max(widestRate, ctx.measureText(formatRate(maximum * rateLine / 3)).width);

	var padding = {
		left: Math.max(48, Math.ceil(widestRate) + 10),
		right: 10,
		top: 12,
		bottom: 24,
	};
	var plotWidth = width - padding.left - padding.right;
	var plotHeight = height - padding.top - padding.bottom;

	ctx.strokeStyle = grid;
	ctx.lineWidth = 1;
	ctx.fillStyle = foreground;
	ctx.textAlign = 'right';
	for (var line = 0; line <= 3; line++) {
		var y = padding.top + plotHeight * line / 3;
		ctx.beginPath();
		ctx.moveTo(padding.left, y);
		ctx.lineTo(width - padding.right, y);
		ctx.stroke();
		var rate = maximum * (1 - line / 3);
		ctx.fillText(formatRate(rate), padding.left - 5, y + 4);
	}

	if (!samples || samples.length < 2) {
		ctx.textAlign = 'center';
		ctx.fillText(_('Waiting for traffic samples...'), padding.left + plotWidth / 2, padding.top + plotHeight / 2);
		return;
	}

	var start = samples[0].t;
	var end = samples[samples.length - 1].t;
	var span = Math.max(1, end - start);
	var tickCount = options && options.compact ? 3 : (plotWidth >= 700 ? 5 : (plotWidth >= 420 ? 3 : 2));
	ctx.textBaseline = 'alphabetic';
	for (var tick = 0; tick < tickCount; tick++) {
		var progress = tick / (tickCount - 1);
		var tickX = padding.left + progress * plotWidth;
		var tickTime = start + progress * span;

		ctx.beginPath();
		ctx.moveTo(tickX, padding.top + plotHeight);
		ctx.lineTo(tickX, padding.top + plotHeight + 4);
		ctx.stroke();
		ctx.textAlign = tick === 0 ? 'left' : (tick === tickCount - 1 ? 'right' : 'center');
		ctx.fillText(formatChartTime(tickTime, span), tickX, height - 6);
	}

	function lineFor(field, color) {
		ctx.beginPath();
		ctx.strokeStyle = color;
		ctx.lineWidth = options && options.compact ? 1.5 : 2;
		samples.forEach(function(sample, index) {
			var x = padding.left + ((sample.t - start) / span) * plotWidth;
			var y = padding.top + plotHeight - (sample[field] / maximum) * plotHeight;
			if (index === 0)
				ctx.moveTo(x, y);
			else
				ctx.lineTo(x, y);
		});
		ctx.stroke();
	}

	lineFor('down', '#16a34a');
	lineFor('up', '#e8590c');
}

function loadCss() {
	if (document.getElementById('live-traffic-css'))
		return;

	var link = document.createElement('link');
	link.id = 'live-traffic-css';
	link.rel = 'stylesheet';
	link.href = L.resource('live-traffic/live-traffic.css');
	document.head.appendChild(link);
}

return baseclass.extend({
	projectTitle: 'LALT - luci-app-live-traffic',
	snapshot: callSnapshot,
	settings: callSettings,
	configure: callConfigure,
	restore: callRestore,
	leases: callDHCPLeases,
	Monitor: Monitor,
	formatRate: formatRate,
	formatBytes: formatBytes,
	drawChart: drawChart,
	loadCss: loadCss,
});
