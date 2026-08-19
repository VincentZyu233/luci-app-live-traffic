'use strict';
'require dom';
'require ui';
'require view';
'require live-traffic.core as traffic';

return view.extend({
	load: function() {
		traffic.loadCss();
		return traffic.settings();
	},

	setBusy: function(message) {
		ui.showModal('LALT', [ E('p', { 'class': 'spinning' }, message) ]);
	},

	applySettings: function() {
		var self = this;
		var interval = Number(this.interval.value);
		if (!window.confirm(_('This changes the nlbwmon refresh interval and reloads its service. Continue?')))
			return;

		this.setBusy(_('Applying collector settings...'));
		return traffic.configure(interval).then(function(result) {
			ui.hideModal();
			if (result.error)
				throw new Error(result.error);
			self.renderState(result.settings || {});
			ui.addNotification(null, E('p', _('Collector settings were applied.')));
		}).catch(function(error) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Unable to apply settings: %s').format(error.message || error)), 'error');
		});
	},

	restoreSettings: function() {
		var self = this;
		if (!window.confirm(_('Restore the nlbwmon refresh interval saved before initialization?')))
			return;

		this.setBusy(_('Restoring collector settings...'));
		return traffic.restore().then(function(result) {
			ui.hideModal();
			if (result.error)
				throw new Error(result.error);
			self.renderState(result.settings || {});
			ui.addNotification(null, E('p', _('The previous collector setting was restored.')));
		}).catch(function(error) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Unable to restore settings: %s').format(error.message || error)), 'error');
		});
	},

	renderState: function(settings) {
		this.current = settings;
		this.interval.value = String(settings.interval || 1);
		this.collectorValue.textContent = settings.nlbwmon_running ? _('Running') : _('Stopped');
		this.refreshValue.textContent = settings.nlbwmon_refresh_interval || '-';
		this.historyValue.textContent = _('%d seconds in browser memory').format(settings.retention_seconds || 600);
		this.offloadValue.textContent = settings.offload_hardware
			? _('Hardware and software offloading enabled')
			: settings.offload_software ? _('Software offloading enabled') : _('Disabled');
		this.managedValue.textContent = settings.managed_nlbwmon ? _('Managed by this application') : _('Not initialized');
		this.restoreButton.disabled = !settings.managed_nlbwmon;
		this.notice.className = 'lt-status' + ((settings.offload_hardware || settings.offload_software) ? ' warning' : '');
		this.notice.textContent = (settings.offload_hardware || settings.offload_software)
			? _('Flow offloading can make per-device accounting incomplete. This application only reports the condition and never modifies firewall settings.')
			: _('Flow offloading is disabled; conntrack accounting can observe forwarded traffic normally.');
	},

	render: function(settings) {
		var self = this;
		this.notice = E('div', { 'class': 'lt-status' });
		this.collectorValue = E('span');
		this.refreshValue = E('span');
		this.historyValue = E('span');
		this.offloadValue = E('span');
		this.managedValue = E('span');
		this.interval = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '1' }, _('1 second')),
			E('option', { 'value': '2' }, _('2 seconds')),
			E('option', { 'value': '5' }, _('5 seconds')),
			E('option', { 'value': '10' }, _('10 seconds'))
		]);
		this.restoreButton = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'click': function() { return self.restoreSettings(); }
		}, _('Restore previous setting'));

		var node = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, traffic.projectTitle),
			E('div', { 'class': 'cbi-map-descr' }, _('Live Traffic Settings')),
			this.notice,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Collector status')),
				E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('nlbwmon service')), E('td', { 'class': 'td left' }, this.collectorValue) ]),
					E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('Collector refresh interval')), E('td', { 'class': 'td left' }, this.refreshValue) ]),
					E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('History retention')), E('td', { 'class': 'td left' }, this.historyValue) ]),
					E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('Flow offloading')), E('td', { 'class': 'td left' }, this.offloadValue) ]),
					E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('Configuration ownership')), E('td', { 'class': 'td left' }, this.managedValue) ])
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Sampling interval')),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, _('Refresh every')),
					E('div', { 'class': 'cbi-value-field' }, this.interval)
				]),
				E('div', { 'class': 'lt-settings-actions' }, [
					E('button', { 'class': 'btn cbi-button cbi-button-positive', 'click': function() { return self.applySettings(); } }, _('Initialize / Apply')),
					this.restoreButton
				])
			])
		]);

		this.renderState(settings || {});
		return node;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null,
});
