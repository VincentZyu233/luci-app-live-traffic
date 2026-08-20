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

	statusText: function(snapshot) {
		var settings = snapshot.settings || {};
		if (snapshot.error)
			return { type: 'error', text: _('Traffic collector error: %s').format(snapshot.error) };
		if (!settings.nlbwmon_running)
			return { type: 'error', text: _('nlbwmon is not running. Open Settings to initialize the collector.') };
		if (settings.offload_hardware || settings.offload_software)
			return {
				type: 'warning',
				text: _('Flow offloading is enabled. Per-device traffic may be lower than the actual value; this application will not change firewall settings.')
			};
		if (settings.nlbwmon_refresh_interval !== settings.interval + 's')
			return {
				type: 'warning',
				text: _('nlbwmon refreshes every %s while this page refreshes every %s second(s). Initialize the collector in Settings for accurate live updates.')
					.format(settings.nlbwmon_refresh_interval, settings.interval)
			};
		return { type: '', text: _('Live sampling is active.') };
	},

	selectDevice: function(key) {
		this.selectedKey = key;
		this.updateSelectedChart();
		this.updateRows();
	},

	updateRows: function() {
		var self = this;
		var devices = this.state ? this.state.devices : [];
		var rows = devices.map(function(device) {
			var row = E('tr', {
				'class': 'tr lt-device-row' + (device.key === self.selectedKey ? ' selected' : ''),
				'tabindex': '0',
				'click': function() { self.selectDevice(device.key); },
				'keydown': function(ev) {
					if (ev.key === 'Enter' || ev.key === ' ')
						self.selectDevice(device.key);
				}
			}, [
				E('td', { 'class': 'td left', 'data-title': _('Device') }, device.name),
				E('td', { 'class': 'td left', 'data-title': _('IP address') }, device.ips.join(', ') || '-'),
				E('td', { 'class': 'td left', 'data-title': _('MAC address') }, device.mac || '-'),
				E('td', { 'class': 'td right', 'data-title': _('Download') }, traffic.formatRate(device.downRate)),
				E('td', { 'class': 'td right', 'data-title': _('Upload') }, traffic.formatRate(device.upRate)),
				E('td', { 'class': 'td right', 'data-title': _('Total') }, traffic.formatBytes(device.rxBytes + device.txBytes))
			]);
			return row;
		});

		if (!rows.length)
			rows.push(E('tr', { 'class': 'tr placeholder' }, [
				E('td', { 'class': 'td', 'colspan': '6' }, E('em', _('No downstream client traffic has been recorded yet.')))
			]));

		dom.content(this.tableBody, rows);
	},

	updateSelectedChart: function() {
		if (!this.state)
			return;

		var selected = null;
		for (var i = 0; i < this.state.devices.length; i++)
			if (this.state.devices[i].key === this.selectedKey)
				selected = this.state.devices[i];

		if (!selected && this.state.devices.length) {
			selected = this.state.devices[0];
			this.selectedKey = selected.key;
		}

		this.selectedTitle.textContent = selected
			? _('Device trend: %s').format(selected.name)
			: _('Device trend');
		traffic.drawChart(this.deviceChart, selected ? this.monitor.samples(selected.key) : []);
	},

	update: function(snapshot) {
		this.lastSnapshot = snapshot;
		this.state = this.monitor.ingest(snapshot, this.leasesPayload);
		var status = this.statusText(snapshot);
		this.status.className = 'lt-status' + (status.type ? ' ' + status.type : '');
		this.status.textContent = status.text;
		traffic.animateMetric(this.wanDown, this.state.wan.downRate, traffic.formatRate);
		traffic.animateMetric(this.wanUp, this.state.wan.upRate, traffic.formatRate);
		traffic.animateMetric(this.clientCount, this.state.devices.length, function(value) { return String(Math.round(value)); });
		this.lastUpdate.textContent = new Date().toLocaleTimeString();
		this.updateRows();

		var self = this;
		window.requestAnimationFrame(function() {
			traffic.drawChart(self.wanChart, self.monitor.samples('__wan__'));
			self.updateSelectedChart();
		});
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
		this.selectedKey = null;
		this.monitor = new traffic.Monitor(snapshot.settings && snapshot.settings.retention_seconds);
		this.status = E('div', { 'class': 'lt-status' });
		this.wanDown = E('span', { 'class': 'lt-kpi-value' }, '-');
		this.wanUp = E('span', { 'class': 'lt-kpi-value' }, '-');
		this.clientCount = E('span', { 'class': 'lt-kpi-value' }, '0');
		this.lastUpdate = E('span', { 'class': 'lt-kpi-value' }, '-');
		this.wanChart = E('canvas', { 'class': 'lt-chart' });
		this.deviceChart = E('canvas', { 'class': 'lt-chart' });
		this.selectedTitle = E('h3', {}, _('Device trend'));
		this.tableBody = E('tbody');
		this.qualityControl = traffic.createQualityControl(true);

		var node = E('div', { 'class': 'cbi-map lt-app' }, [
			E('div', { 'class': 'lt-titlebar' }, [
				E('h2', {}, traffic.projectTitle),
				E('div', { 'class': 'lt-title-actions' }, [
					this.qualityControl,
					traffic.createProjectLink()
				])
			]),
			this.status,
			E('div', { 'class': 'lt-kpis' }, [
				E('div', { 'class': 'lt-kpi' }, [ E('span', { 'class': 'lt-kpi-label' }, _('WAN download')), this.wanDown ]),
				E('div', { 'class': 'lt-kpi' }, [ E('span', { 'class': 'lt-kpi-label' }, _('WAN upload')), this.wanUp ]),
				E('div', { 'class': 'lt-kpi' }, [ E('span', { 'class': 'lt-kpi-label' }, _('Active devices')), this.clientCount ]),
				E('div', { 'class': 'lt-kpi' }, [ E('span', { 'class': 'lt-kpi-label' }, _('Last update')), this.lastUpdate ])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('WAN trend')),
				E('div', { 'class': 'lt-legend' }, [ E('span', { 'class': 'download' }, _('Download')), E('span', { 'class': 'upload' }, _('Upload')) ]),
				this.wanChart
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Downstream devices')),
				E('table', { 'class': 'table' }, [
					E('thead', {}, E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th left' }, _('Device')),
						E('th', { 'class': 'th left' }, _('IP address')),
						E('th', { 'class': 'th left' }, _('MAC address')),
						E('th', { 'class': 'th right' }, _('Download')),
						E('th', { 'class': 'th right' }, _('Upload')),
						E('th', { 'class': 'th right' }, _('Total'))
					])),
					this.tableBody
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				this.selectedTitle,
				E('div', { 'class': 'lt-legend' }, [ E('span', { 'class': 'download' }, _('Download')), E('span', { 'class': 'upload' }, _('Upload')) ]),
				this.deviceChart
			])
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
