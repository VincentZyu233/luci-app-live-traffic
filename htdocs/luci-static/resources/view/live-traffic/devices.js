'use strict';
'require dom';
'require poll';
'require view';
'require live-traffic.core as traffic';

return view.extend({
	load: function() {
		traffic.loadCss();
		return Promise.all([ traffic.snapshot(), traffic.leases() ]);
	},

	update: function(snapshot) {
		var self = this;
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

		var nodes = this.state.devices.map(function(device) {
			var canvas = E('canvas', { 'class': 'lt-chart compact' });
			var node = E('section', { 'class': 'lt-device' }, [
				E('div', { 'class': 'lt-device-head' }, [
					E('div', {}, [
						E('h3', { 'class': 'lt-device-name' }, device.name),
						E('div', { 'class': 'lt-device-meta' }, (device.ips.join(', ') || '-') + ' · ' + (device.mac || '-'))
					]),
					E('div', { 'class': 'lt-device-rates' }, [
						E('span', { 'class': 'download', 'title': _('Download') }, '↓ ' + traffic.formatRate(device.downRate)),
						E('span', { 'class': 'upload', 'title': _('Upload') }, '↑ ' + traffic.formatRate(device.upRate))
					])
				]),
				canvas
			]);

			window.requestAnimationFrame(function() {
				traffic.drawChart(canvas, self.monitor.samples(device.key), { compact: true });
			});
			return node;
		});

		if (!nodes.length)
			nodes.push(E('div', { 'class': 'lt-status' }, _('No downstream client traffic has been recorded yet.')));
		dom.content(this.grid, nodes);
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
		this.monitor = new traffic.Monitor(snapshot.settings && snapshot.settings.retention_seconds);
		this.status = E('div', { 'class': 'lt-status' });
		this.grid = E('div', { 'class': 'lt-devices' });
		var node = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Device Matrix')),
			this.status,
			E('div', { 'class': 'lt-legend' }, [ E('span', { 'class': 'download' }, _('Download')), E('span', { 'class': 'upload' }, _('Upload')) ]),
			this.grid
		]);

		this.update(snapshot);
		poll.add(this.refresh.bind(this), Number(snapshot.settings && snapshot.settings.interval) || 1);
		return node;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
});
