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

var QUALITY_STORAGE_KEY = 'lalt.uiQuality';
var PROJECT_URL = 'https://github.com/VincentZyu233/luci-app-live-traffic';
var QUALITY_NAMES = [ 'auto', 'low', 'medium', 'high', 'ultra' ];
var QUALITY_PROFILES = {
	low: { rank: 0, duration: 0, dpr: 1, area: false, glow: false, continuous: false },
	medium: { rank: 1, duration: 350, dpr: 1.5, area: true, glow: false, continuous: false },
	high: { rank: 2, duration: 650, dpr: 2, area: true, glow: true, continuous: false },
	ultra: { rank: 3, duration: 650, dpr: 2.5, area: true, glow: true, continuous: true },
};
var qualityControls = [];
var chartStates = [];
var metricStates = [];
var frameRequest = null;
var lastFrameTime = 0;
var measuredFrames = 0;
var slowFrames = 0;
var autoState = {
	badWindows: 0,
	penaltyUntil: 0,
	retryUsed: false,
	permanentLow: false,
	retryTimer: null,
};
var chartObserver = null;
var fallbackQuality = 'auto';
var reducedMotionQuery = typeof window.matchMedia === 'function'
	? window.matchMedia('(prefers-reduced-motion: reduce)')
	: null;

function validQuality(value) {
	return QUALITY_NAMES.indexOf(value) >= 0;
}

function readQuality() {
	try {
		var value = window.localStorage.getItem(QUALITY_STORAGE_KEY);
		return validQuality(value) ? value : fallbackQuality;
	}
	catch (error) {
		return fallbackQuality;
	}
}

function prefersReducedMotion() {
	return reducedMotionQuery && reducedMotionQuery.matches;
}

function capableOfMediumQuality() {
	var cores = typeof navigator !== 'undefined' ? Number(navigator.hardwareConcurrency) || 0 : 0;
	var memory = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) || 0 : 0;
	var finePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
	var wideViewport = Number(window.innerWidth) >= 900;

	return cores >= 8 && (!memory || memory >= 8) && finePointer && wideViewport;
}

function resetAutoState() {
	autoState.badWindows = 0;
	autoState.penaltyUntil = 0;
	autoState.retryUsed = false;
	autoState.permanentLow = false;
	if (autoState.retryTimer != null) {
		window.clearTimeout(autoState.retryTimer);
		autoState.retryTimer = null;
	}
}

function qualityState() {
	var selected = readQuality();
	var reduced = prefersReducedMotion();
	var resolved = selected;

	if (selected === 'auto') {
		resolved = !reduced && capableOfMediumQuality() && !autoState.permanentLow && Date.now() >= autoState.penaltyUntil
			? 'medium'
			: 'low';
	}

	return {
		selected: selected,
		resolved: resolved,
		motion: !reduced,
		profile: QUALITY_PROFILES[resolved],
	};
}

function qualityLabel(value) {
	return {
		auto: _('Auto'),
		low: _('Low'),
		medium: _('Medium'),
		high: _('High'),
		ultra: _('Ultra'),
	}[value] || _('Auto');
}

function applyQualityAttributes() {
	if (!document.querySelectorAll)
		return;

	var state = qualityState();
	var nodes = document.querySelectorAll('.lt-app');
	for (var i = 0; i < nodes.length; i++) {
		nodes[i].setAttribute('data-lalt-quality', state.resolved);
		nodes[i].setAttribute('data-lalt-motion', state.motion ? 'on' : 'off');
		nodes[i].setAttribute('data-lalt-paused', document.hidden ? 'true' : 'false');
	}
}

function refreshQualityControls() {
	var state = qualityState();
	for (var i = 0; i < qualityControls.length; i++) {
		var control = qualityControls[i];
		if (control.select)
			control.select.value = state.selected;
		if (control.buttons)
			control.buttons.forEach(function(button) {
				button.className = 'btn lt-quality-option' + (button.getAttribute('data-quality') === state.selected ? ' active' : '');
			});
		if (control.resolved)
			control.resolved.textContent = _('Effective quality: %s').format(qualityLabel(state.resolved));
		control.node.title = _('Effective quality: %s').format(qualityLabel(state.resolved));
	}
	applyQualityAttributes();
}

function wakeAnimator() {
	if (frameRequest != null || document.hidden || typeof window.requestAnimationFrame !== 'function')
		return;
	frameRequest = window.requestAnimationFrame(animationFrame);
}

function notifyQualityChange() {
	refreshQualityControls();
	for (var i = 0; i < chartStates.length; i++)
		chartStates[i].forceDraw = true;
	wakeAnimator();
}

function setQuality(value) {
	if (!validQuality(value))
		value = 'auto';
	fallbackQuality = value;
	try {
		window.localStorage.setItem(QUALITY_STORAGE_KEY, value);
	}
	catch (error) {
		/* The current page still follows the default when storage is unavailable. */
	}
	resetAutoState();
	notifyQualityChange();
	return qualityState();
}

function reportFrameWindow() {
	if (readQuality() !== 'auto' || qualityState().resolved !== 'medium') {
		measuredFrames = 0;
		slowFrames = 0;
		return;
	}

	if (measuredFrames < 45)
		return;

	if (slowFrames / measuredFrames > 0.2)
		autoState.badWindows++;
	else
		autoState.badWindows = 0;

	measuredFrames = 0;
	slowFrames = 0;
	if (autoState.badWindows < 3)
		return;

	autoState.badWindows = 0;
	if (autoState.retryUsed) {
		autoState.permanentLow = true;
		notifyQualityChange();
		return;
	}

	autoState.penaltyUntil = Date.now() + 30000;
	if (autoState.retryTimer != null)
		window.clearTimeout(autoState.retryTimer);
	autoState.retryTimer = window.setTimeout(function() {
		autoState.penaltyUntil = 0;
		autoState.retryUsed = true;
		autoState.retryTimer = null;
		notifyQualityChange();
	}, 30000);
	notifyQualityChange();
}

function createQualityControl(compact) {
	var control = { select: null, buttons: null, resolved: null, node: null };
	var values = QUALITY_NAMES.slice();

	if (compact) {
		control.select = E('select', {
			'class': 'cbi-input-select lt-quality-select',
			'change': function(ev) { setQuality(ev.target.value); }
		}, values.map(function(value) {
			return E('option', { 'value': value }, qualityLabel(value));
		}));
		control.node = E('label', { 'class': 'lt-quality-compact' }, [
			E('span', {}, _('UI quality')),
			control.select
		]);
	}
	else {
		control.buttons = values.map(function(value) {
			return E('button', {
				'class': 'btn lt-quality-option',
				'type': 'button',
				'data-quality': value,
				'click': function() { setQuality(value); }
			}, qualityLabel(value));
		});
		control.resolved = E('div', { 'class': 'lt-quality-resolved' });
		control.node = E('div', { 'class': 'lt-quality-picker' }, [
			E('div', { 'class': 'lt-quality-segments' }, control.buttons),
			control.resolved,
			E('div', { 'class': 'cbi-value-description' }, _('This preference is stored in this browser and does not change router sampling.'))
		]);
	}

	qualityControls.push(control);
	refreshQualityControls();
	return control.node;
}

function createProjectLink() {
	return E('a', {
		'class': 'btn cbi-button cbi-button-neutral lt-project-link',
		'href': PROJECT_URL,
		'target': '_blank',
		'rel': 'noopener noreferrer',
		'aria-label': _('Open project on GitHub'),
		'title': _('Open project on GitHub')
	}, 'GitHub ↗');
}

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

function easing(progress) {
	return 1 - Math.pow(1 - progress, 3);
}

function copySamples(samples) {
	return (samples || []).map(function(sample) {
		return { t: Number(sample.t), down: Number(sample.down) || 0, up: Number(sample.up) || 0 };
	});
}

function interpolateSamples(previous, target, progress) {
	if (!previous || !previous.length || progress >= 1)
		return copySamples(target);

	var byTime = {};
	for (var i = 0; i < previous.length; i++)
		byTime[String(previous[i].t)] = previous[i];
	var fallback = previous[previous.length - 1];

	return target.map(function(sample) {
		var source = byTime[String(sample.t)] || fallback || sample;
		return {
			t: sample.t,
			down: source.down + (sample.down - source.down) * progress,
			up: source.up + (sample.up - source.up) * progress,
		};
	});
}

function sampleMaximum(samples) {
	var maximum = 1;
	for (var i = 0; i < samples.length; i++)
		maximum = Math.max(maximum, samples[i].down, samples[i].up);
	return maximum;
}

function chartPoint(sample, field, start, span, maximum, padding, plotWidth, plotHeight) {
	return {
		x: padding.left + ((sample.t - start) / span) * plotWidth,
		y: padding.top + plotHeight - (sample[field] / maximum) * plotHeight,
	};
}

function drawArea(ctx, samples, field, colors, start, span, maximum, padding, plotWidth, plotHeight) {
	if (!ctx.createLinearGradient || !ctx.fill || !ctx.closePath)
		return;

	var gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
	gradient.addColorStop(0, colors[0]);
	gradient.addColorStop(1, colors[1]);
	ctx.beginPath();
	ctx.moveTo(chartPoint(samples[0], field, start, span, maximum, padding, plotWidth, plotHeight).x, padding.top + plotHeight);
	for (var i = 0; i < samples.length; i++) {
		var point = chartPoint(samples[i], field, start, span, maximum, padding, plotWidth, plotHeight);
		ctx.lineTo(point.x, point.y);
	}
	ctx.lineTo(chartPoint(samples[samples.length - 1], field, start, span, maximum, padding, plotWidth, plotHeight).x, padding.top + plotHeight);
	ctx.closePath();
	ctx.fillStyle = gradient;
	ctx.fill();
}

function drawLine(ctx, samples, field, color, state, start, span, maximum, padding, plotWidth, plotHeight) {
	function trace() {
		ctx.beginPath();
		for (var i = 0; i < samples.length; i++) {
			var point = chartPoint(samples[i], field, start, span, maximum, padding, plotWidth, plotHeight);
			if (i === 0)
				ctx.moveTo(point.x, point.y);
			else
				ctx.lineTo(point.x, point.y);
		}
	}

	ctx.strokeStyle = color;
	var lineWidth = state.options.compact ? 1.5 : (state.profile.rank >= 2 ? 2.4 : 2);
	if (state.profile.glow) {
		trace();
		ctx.globalAlpha = 0.2;
		ctx.lineWidth = lineWidth + 5;
		ctx.stroke();
		ctx.globalAlpha = 1;
		ctx.shadowColor = color;
		ctx.shadowBlur = state.profile.rank >= 3 ? 9 : 5;
	}
	trace();
	ctx.lineWidth = lineWidth;
	ctx.stroke();
	ctx.shadowBlur = 0;
}

function drawMovingPoint(ctx, samples, field, color, phase, start, span, maximum, padding, plotWidth, plotHeight) {
	if (!ctx.arc || samples.length < 2)
		return;

	var position = phase * (samples.length - 1);
	var index = Math.min(samples.length - 2, Math.floor(position));
	var fraction = position - index;
	var first = samples[index];
	var second = samples[index + 1];
	var sample = {
		t: first.t + (second.t - first.t) * fraction,
		down: first.down + (second.down - first.down) * fraction,
		up: first.up + (second.up - first.up) * fraction,
	};
	var point = chartPoint(sample, field, start, span, maximum, padding, plotWidth, plotHeight);
	ctx.beginPath();
	ctx.fillStyle = color;
	ctx.shadowColor = color;
	ctx.shadowBlur = 12;
	ctx.arc(point.x, point.y, 2.6, 0, Math.PI * 2);
	ctx.fill();
	ctx.shadowBlur = 0;
}

function renderChart(state, frameTime, progress) {
	var canvas = state.canvas;
	var rect = canvas.getBoundingClientRect();
	var width = Math.max(280, Math.floor(rect.width || 600));
	var height = Math.max(110, Math.floor(rect.height || 180));
	var ratio = Math.min(window.devicePixelRatio || 1, state.profile.dpr);
	if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
		canvas.width = Math.floor(width * ratio);
		canvas.height = Math.floor(height * ratio);
	}

	var ctx = canvas.getContext('2d');
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	ctx.clearRect(0, 0, width, height);

	var samples = interpolateSamples(state.previous, state.target, easing(progress));
	var maximum = state.previousMaximum + (state.targetMaximum - state.previousMaximum) * easing(progress);
	var style = window.getComputedStyle(canvas);
	var foreground = style.color || '#475569';
	var grid = 'rgba(127, 127, 127, 0.18)';
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
		ctx.fillText(formatRate(maximum * (1 - line / 3)), padding.left - 5, y + 4);
	}

	if (samples.length < 2) {
		ctx.textAlign = 'center';
		ctx.fillText(_('Waiting for traffic samples...'), padding.left + plotWidth / 2, padding.top + plotHeight / 2);
		return;
	}

	var oldStart = state.previous.length ? state.previous[0].t : samples[0].t;
	var oldEnd = state.previous.length ? state.previous[state.previous.length - 1].t : samples[samples.length - 1].t;
	var targetStart = samples[0].t;
	var targetEnd = samples[samples.length - 1].t;
	var start = oldStart + (targetStart - oldStart) * easing(progress);
	var end = oldEnd + (targetEnd - oldEnd) * easing(progress);
	var span = Math.max(1, end - start);
	var tickCount = state.options.compact ? 3 : (plotWidth >= 700 ? 5 : (plotWidth >= 420 ? 3 : 2));
	ctx.textBaseline = 'alphabetic';
	for (var tick = 0; tick < tickCount; tick++) {
		var tickProgress = tick / (tickCount - 1);
		var tickX = padding.left + tickProgress * plotWidth;
		var tickTime = start + tickProgress * span;
		ctx.beginPath();
		ctx.moveTo(tickX, padding.top + plotHeight);
		ctx.lineTo(tickX, padding.top + plotHeight + 4);
		ctx.stroke();
		ctx.textAlign = tick === 0 ? 'left' : (tick === tickCount - 1 ? 'right' : 'center');
		ctx.fillText(formatChartTime(tickTime, span), tickX, height - 6);
	}

	ctx.save();
	ctx.beginPath();
	ctx.rect(padding.left, padding.top, plotWidth, plotHeight);
	ctx.clip();

	if (state.profile.area) {
		drawArea(ctx, samples, 'down', [ 'rgba(22, 163, 74, 0.24)', 'rgba(6, 182, 212, 0.015)' ], start, span, maximum, padding, plotWidth, plotHeight);
		drawArea(ctx, samples, 'up', [ 'rgba(232, 89, 12, 0.2)', 'rgba(220, 38, 38, 0.01)' ], start, span, maximum, padding, plotWidth, plotHeight);
	}

	if (state.profile.rank >= 3 && state.motion && ctx.fillRect) {
		var scanX = padding.left + ((frameTime % 3600) / 3600) * plotWidth;
		if (ctx.createLinearGradient) {
			var scan = ctx.createLinearGradient(scanX - 14, 0, scanX + 14, 0);
			scan.addColorStop(0, 'rgba(255, 255, 255, 0)');
			scan.addColorStop(0.5, 'rgba(255, 255, 255, 0.09)');
			scan.addColorStop(1, 'rgba(255, 255, 255, 0)');
			ctx.fillStyle = scan;
		}
		else {
			ctx.fillStyle = 'rgba(255, 255, 255, 0.055)';
		}
		ctx.fillRect(scanX - 14, padding.top, 28, plotHeight);
	}

	drawLine(ctx, samples, 'down', '#16a34a', state, start, span, maximum, padding, plotWidth, plotHeight);
	drawLine(ctx, samples, 'up', '#e8590c', state, start, span, maximum, padding, plotWidth, plotHeight);
	if (state.profile.rank >= 3 && state.motion) {
		var phase = (frameTime % 3000) / 3000;
		drawMovingPoint(ctx, samples, 'down', '#22d3ee', phase, start, span, maximum, padding, plotWidth, plotHeight);
		drawMovingPoint(ctx, samples, 'up', '#fb7185', (phase + 0.5) % 1, start, span, maximum, padding, plotWidth, plotHeight);
	}
	ctx.restore();
}

function observeChart(state) {
	if (typeof window.IntersectionObserver !== 'function')
		return;
	if (!chartObserver)
		chartObserver = new window.IntersectionObserver(function(entries) {
			entries.forEach(function(entry) {
				if (entry.target._laltChartState)
					entry.target._laltChartState.visible = entry.isIntersecting;
			});
			wakeAnimator();
		});
	chartObserver.observe(state.canvas);
}

function drawChart(canvas, samples, options) {
	if (!canvas)
		return;

	var currentQuality = qualityState();
	var state = canvas._laltChartState;
	if (!state) {
		state = canvas._laltChartState = {
			canvas: canvas,
			options: options || {},
			previous: [],
			target: [],
			previousMaximum: 1,
			targetMaximum: 1,
			startedAt: 0,
			updatedAt: 0,
			visible: true,
			forceDraw: false,
		};
		chartStates.push(state);
		observeChart(state);
	}

	state.options = options || {};
	state.previous = state.target.length ? state.target : copySamples(samples);
	state.target = copySamples(samples);
	state.previousMaximum = state.targetMaximum || sampleMaximum(state.previous);
	state.targetMaximum = sampleMaximum(state.target);
	state.profile = currentQuality.profile;
	state.motion = currentQuality.motion;
	state.startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
	state.updatedAt = state.startedAt;
	state.duration = state.previous.length && currentQuality.motion ? state.profile.duration : 0;
	renderChart(state, state.startedAt, state.duration ? 0 : 1);
	wakeAnimator();
}

function animateMetric(element, value, formatter) {
	if (!element)
		return;

	var numeric = Number(value) || 0;
	var currentQuality = qualityState();
	var state = element._laltMetricState;
	if (!state) {
		state = element._laltMetricState = { element: element, value: numeric, target: numeric, peak: numeric, formatter: formatter };
		metricStates.push(state);
		element.textContent = formatter(numeric);
		return;
	}

	state.value = state.target;
	state.target = numeric;
	state.formatter = formatter;
	state.startedAt = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
	state.duration = currentQuality.motion ? currentQuality.profile.duration : 0;
	element.classList.remove('lt-rate-rising', 'lt-rate-falling', 'lt-rate-updated', 'lt-rate-peak');
	if (numeric > state.value)
		element.classList.add('lt-rate-rising');
	else if (numeric < state.value)
		element.classList.add('lt-rate-falling');
	if (state.duration)
		element.classList.add('lt-rate-updated');
	if (numeric > state.peak) {
		state.peak = numeric;
		if (currentQuality.profile.rank >= 2)
			element.classList.add('lt-rate-peak');
	}
	if (!state.duration)
		element.textContent = formatter(numeric);
	wakeAnimator();
}

function animationFrame(frameTime) {
	frameRequest = null;
	if (document.hidden)
		return;

	if (lastFrameTime) {
		var delta = frameTime - lastFrameTime;
		measuredFrames++;
		if (delta > 34)
			slowFrames++;
	}
	lastFrameTime = frameTime;
	var active = false;
	var currentQuality = qualityState();

	for (var i = chartStates.length - 1; i >= 0; i--) {
		var chart = chartStates[i];
		if (chart.canvas.isConnected === false) {
			chartStates.splice(i, 1);
			continue;
		}
		chart.profile = currentQuality.profile;
		chart.motion = currentQuality.motion;
		if (!chart.visible)
			continue;
		var elapsed = frameTime - chart.startedAt;
		var progress = chart.duration ? Math.min(1, elapsed / chart.duration) : 1;
		if (chart.forceDraw || progress < 1 || (chart.profile.continuous && chart.motion)) {
			renderChart(chart, frameTime, progress);
			chart.forceDraw = false;
		}
		if (progress < 1 || (chart.profile.continuous && chart.motion))
			active = true;
	}

	for (var metricIndex = metricStates.length - 1; metricIndex >= 0; metricIndex--) {
		var metric = metricStates[metricIndex];
		if (metric.element.isConnected === false) {
			metricStates.splice(metricIndex, 1);
			continue;
		}
		var metricProgress = metric.duration ? Math.min(1, (frameTime - metric.startedAt) / metric.duration) : 1;
		metric.element.textContent = metric.formatter(metric.value + (metric.target - metric.value) * easing(metricProgress));
		if (metricProgress < 1)
			active = true;
		else
			metric.element.classList.remove('lt-rate-updated');
	}

	reportFrameWindow();
	if (active)
		wakeAnimator();
	else
		lastFrameTime = 0;
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

if (typeof window.addEventListener === 'function') {
	window.addEventListener('storage', function(event) {
		if (event.key === QUALITY_STORAGE_KEY) {
			fallbackQuality = validQuality(event.newValue) ? event.newValue : 'auto';
			resetAutoState();
			notifyQualityChange();
		}
	});
	window.addEventListener('resize', notifyQualityChange);
}

if (reducedMotionQuery) {
	if (typeof reducedMotionQuery.addEventListener === 'function')
		reducedMotionQuery.addEventListener('change', notifyQualityChange);
	else if (typeof reducedMotionQuery.addListener === 'function')
		reducedMotionQuery.addListener(notifyQualityChange);
}

if (typeof document.addEventListener === 'function')
	document.addEventListener('visibilitychange', function() {
		lastFrameTime = 0;
		applyQualityAttributes();
		if (!document.hidden) {
			for (var i = 0; i < chartStates.length; i++)
				chartStates[i].forceDraw = true;
			wakeAnimator();
		}
	});

return baseclass.extend({
	projectTitle: 'LALT - luci-app-live-traffic',
	projectUrl: PROJECT_URL,
	snapshot: callSnapshot,
	settings: callSettings,
	configure: callConfigure,
	restore: callRestore,
	leases: callDHCPLeases,
	Monitor: Monitor,
	formatRate: formatRate,
	formatBytes: formatBytes,
	drawChart: drawChart,
	animateMetric: animateMetric,
	qualityState: qualityState,
	setQuality: setQuality,
	createQualityControl: createQualityControl,
	createProjectLink: createProjectLink,
	qualityLabel: qualityLabel,
	loadCss: loadCss,
});
