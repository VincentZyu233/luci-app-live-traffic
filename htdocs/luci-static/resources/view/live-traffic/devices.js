'use strict';
'require poll';
'require view';
'require live-traffic.core as traffic';

return view.extend({
	load: function() {
		traffic.loadCss();
		return Promise.all([ traffic.snapshot(), traffic.leases() ]);
	},

	createCard: function(device) {
		var canvas = E('canvas', { 'class': 'lt-chart compact' });
		var name = E('h3', { 'class': 'lt-device-name' });
		var meta = E('div', { 'class': 'lt-device-meta' });
		var down = E('span', { 'class': 'download', 'title': _('Download') });
		var up = E('span', { 'class': 'upload', 'title': _('Upload') });
		var node = E('section', { 'class': 'lt-device' }, [
			E('div', { 'class': 'lt-device-head' }, [
				E('div', {}, [ name, meta ]),
				E('div', { 'class': 'lt-device-rates' }, [ down, up ])
			]),
			canvas
		]);

		return { key: device.key, node: node, canvas: canvas, name: name, meta: meta, down: down, up: up };
	},

	updateCard: function(card, device) {
		card.name.textContent = device.name;
		card.meta.textContent = (device.ips.join(', ') || '-') + ' · ' + (device.mac || '-');
		traffic.animateMetric(card.down, device.downRate, function(value) { return '↓ ' + traffic.formatRate(value); });
		traffic.animateMetric(card.up, device.upRate, function(value) { return '↑ ' + traffic.formatRate(value); });
	},

	animateCardMove: function(node, before) {
		var quality = traffic.qualityState();
		if (!before || !quality.motion || quality.profile.rank < 2 || typeof window.requestAnimationFrame !== 'function')
			return;

		var after = node.getBoundingClientRect();
		var deltaX = before.left - after.left;
		var deltaY = before.top - after.top;
		if (!deltaX && !deltaY)
			return;

		node.style.transition = 'none';
		node.style.transform = 'translate(' + deltaX + 'px, ' + deltaY + 'px)';
		window.requestAnimationFrame(function() {
			node.style.transition = 'transform 480ms cubic-bezier(.2, .8, .2, 1)';
			node.style.transform = '';
		});
	},

	update: function(snapshot) {
		this.state = this.monitor.ingest(snapshot, this.leasesPayload);
		var settings = snapshot.settings || {};
		if (snapshot.error) {
			this.status.className = 'lt-status error';
			this.status.textContent = _('Traffic collector error: %s').format(snapshot.error);
		}
		else if (settings.offload_hardware || settings.offload_software) {
			this.status.className = 'lt-status warning';
			this.status.textContent = _('Flow offloading is enabled, so per-device values may be lower than actual traffic.');
		}
		else {
			this.status.className = 'lt-status';
			this.status.textContent = _('Showing %d downstream device(s).').format(this.state.devices.length);
		}

		var before = {};
		Object.keys(this.cards).forEach(function(key) {
			before[key] = this.cards[key].node.getBoundingClientRect();
		}, this);

		var active = {};
		for (var i = 0; i < this.state.devices.length; i++) {
			var device = this.state.devices[i];
			var card = this.cards[device.key];
			if (!card) {
				card = this.cards[device.key] = this.createCard(device);
				this.grid.appendChild(card.node);
			}
			active[device.key] = true;
			this.updateCard(card, device);
			this.grid.appendChild(card.node);
		}

		Object.keys(this.cards).forEach(function(key) {
			if (!active[key]) {
				this.cards[key].node.remove();
				delete this.cards[key];
			}
		}, this);

		if (!this.state.devices.length) {
			if (!this.placeholder) {
				this.placeholder = E('div', { 'class': 'lt-status' }, _('No downstream client traffic has been recorded yet.'));
				this.grid.appendChild(this.placeholder);
			}
		}
		else if (this.placeholder) {
			this.placeholder.remove();
			this.placeholder = null;
		}

		for (var deviceIndex = 0; deviceIndex < this.state.devices.length; deviceIndex++) {
			var current = this.state.devices[deviceIndex];
			var currentCard = this.cards[current.key];
			this.animateCardMove(currentCard.node, before[current.key]);
			traffic.drawChart(currentCard.canvas, this.monitor.samples(current.key), { compact: true });
		}
	},

	refresh: function() {
		var self = this;
		this.leaseTicks++;
		var refreshLeases = this.leaseTicks % 30 === 0;
		var promises = [ traffic.snapshot() ];
		if (refreshLeases)
			promises.push(traffic.leases());

		return Promise.all(promises).then(function(values) {
			if (refreshLeases)
				self.leasesPayload = values[1] || {};
			self.update(values[0] || {});
		}).catch(function(error) {
			self.status.className = 'lt-status error';
			self.status.textContent = _('Unable to refresh traffic data: %s').format(error.message || error);
		});
	},

	render: function(data) {
		var snapshot = data[0] || {};
		this.leasesPayload = data[1] || {};
		this.leaseTicks = 0;
		this.cards = {};
		this.placeholder = null;
		this.monitor = new traffic.Monitor(snapshot.settings && snapshot.settings.retention_seconds);
		this.status = E('div', { 'class': 'lt-status' });
		this.grid = E('div', { 'class': 'lt-devices' });
		this.qualityControl = traffic.createQualityControl(true);
		var node = E('div', { 'class': 'cbi-map lt-app' }, [
			E('div', { 'class': 'lt-titlebar' }, [
				E('h2', {}, traffic.projectTitle),
				E('div', { 'class': 'lt-title-actions' }, [
					this.qualityControl,
					traffic.createProjectLink()
				])
			]),
			E('div', { 'class': 'cbi-map-descr' }, _('Device Matrix')),
			this.status,
			E('div', { 'class': 'lt-legend' }, [ E('span', { 'class': 'download' }, _('Download')), E('span', { 'class': 'upload' }, _('Upload')) ]),
			this.grid
		]);
		var quality = traffic.qualityState();
		node.setAttribute('data-lalt-quality', quality.resolved);
		node.setAttribute('data-lalt-motion', quality.motion ? 'on' : 'off');

		this.update(snapshot);
		poll.add(this.refresh.bind(this), Number(snapshot.settings && snapshot.settings.interval) || 1);
		return node;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
});
