var User = Composer.RelationalModel.extend({
	base_url: '/users',

	relations: {
		personas: {
			type: Composer.HasMany,
			filter_collection: 'PersonasFilter',
			master: function() { return turtl.profile.get('personas'); },
			options: {
				filter: function(p) {
					return p.get('user_id') == turtl.user.id();
				}
			}
		},

		settings: {
			type: Composer.HasMany,
			collection: 'Settings'
		}
	},

	public_fields: [
		'id',
		'storage'
	],

	private_fields: [
		'settings'
	],

	logged_in: false,

	init: function()
	{
		this.logged_in = false;

		// whenever the user settings change, automatically save them (encrypted).
		this.bind_relational('settings', ['change'], this.save_settings.bind(this), 'user:save_settings');
	},

	login: function(options)
	{
		turtl.remote.send('do-login', {
			username: this.get('username'),
			password: this.get('password')
		}, {
			success: function(data) {
				this.set(data);
				this.unset('username');
				this.unset('password');
				this.logged_in = true;
				this.trigger('login', options);
				if(options.success) options.success();
			}.bind(this),
			complete: options.complete,
			error: options.error
		});
	},

	/**
	 * add a new user.
	 *
	 * note that we don't do the usual model -> local db -> API pattern here
	 * because the local db relies on the user id (which is generated by the
	 * API) and because in the off-chance that there's a failure syncing the
	 * user record after the fact, it could serverely screw some things up in
	 * the client.
	 *
	 * instead, we post to the API, then once we have a full user record that we
	 * know is in the API, we wait for the local DB to init (poll it) and then
	 * add our shiny new user record to it.
	 */
	join: function(options)
	{
		options || (options = {});
		var data = {data: {a: this.get_auth()}};
		if(Tstorage.invited_by)
		{
			data.invited_by = Tstorage.invited_by;
		}

		// grab the promo code, if we haven't already used it.
		var used_promos = JSON.parse(Tstorage.used_promos || '[]');
		var promo = options.promo;
		if(promo) //&& (!used_promos || !used_promos.contains(promo)))
		{
			data.promo = promo;
		}

		turtl.api.post('/users', data, {
			success: function(user) {
				if(data.promo)
				{
					// if we used a promo, track it to make sure this client
					// doesn't use it again.
					//Tstorage.used_promos = JSON.stringify(JSON.parse(Tstorage.used_promos || '[]').push(data.promo));
				}

				// once we have a successful signup with the invite/promo, wipe
				// them out so we don't keep counting multiple times.
				delete Tstorage.invited_by;
				delete Tstorage.promo;

				// once we have the user record, wait until the user is logged
				// in. then we poll turtl.db until our local db object exists.
				// once we're sure we have it, we save the new user record to
				// the local db.
				this.bind('login', function() {
					this.unbind('login', 'user:join:add_local_record');
					var check_db = function()
					{
						if(!turtl.db)
						{
							check_db.delay(10, this);
							return false;
						}
						this.save();
					}.bind(this);
					check_db.delay(1, this);
				}.bind(this), 'user:join:add_local_record');
				if(options.success) options.success.apply(this, arguments);
			}.bind(this),
			error: function(e) {
				barfr.barf('Error adding user: '+ e);
				if(options.error) options.error(e);
			}.bind(this)
		});
	},

	write_cookie: function(options)
	{
		options || (options = {});
		var duration = options.duration ? options.duration : 30;
		var key = this.get_key();
		var auth = this.get_auth();
		if(!key || !auth) return false;

		var save = {
			id: this.id(),
			k: tcrypt.key_to_string(key),
			a: auth,
			invite_code: this.get('invite_code'),
			storage: this.get('storage')
		};
		Tstorage[config.user_cookie] = JSON.encode(save);
	},

	logout: function()
	{
		this.logged_in = false;
		this.clear();
		delete Tstorage[config.user_cookie];
		turtl.remote.send('do-logout');
		/*
		this.unbind_relational('personas', ['saved'], 'user:track_personas');
		this.unbind_relational('personas', ['destroy'], 'user:track_personas:destroy');
		this.unbind_relational('settings', ['change'], 'user:save_settings');

		// clear user data
		var personas = this.get('personas');
		if(personas) personas.each(function(p) {
			p.unbind();
			p.destroy({silent: true, skip_sync: true});
		});
		this.get('personas').unbind().clear();
		this.get('settings').unbind().clear();
		*/
		this.trigger('logout', this);
	},

	save_settings: function()
	{
		this.save({
			success: function(res) {
				this.trigger('saved', res);
			}.bind(this),
			error: function(model, err) {
				barfr.barf('There was an error saving your user settings: '+ err);
			}.bind(this)
		});
	},

	get_key: function()
	{
		var key = this.key;
		if(key) return key;

		var username = this.get('username');
		var password = this.get('password');

		if(!username || !password) return false;

		// TODO: abstract key generation a bit better (iterations/keysize mainly)
		var key = tcrypt.key(password, username + ':a_pinch_of_salt', {key_size: 32, iterations: 400});

		// cache it
		this.key = key;

		return key;
	},

	get_auth: function()
	{
		if(this.auth) return this.auth;

		var username = this.get('username');
		var password = this.get('password');

		if(!username || !password) return false;

		var user_record = tcrypt.hash(password) +':'+ username;
		// use username as salt/initial vector
		var key = this.get_key();
		var iv = tcrypt.iv(username+'4c281987249be78a');	// make sure IV always has 16 bytes

		// note we serialize with version 0 (the original Turtl serialization
		// format) for backwards compat
		var auth = tcrypt.encrypt(key, user_record, {iv: iv, version: 0});

		// save auth
		this.auth = auth;

		return auth;
	},

	test_auth: function(options)
	{
		options || (options = {});
		turtl.remote.send('do-login', {
			username: this.get('username'),
			password: this.get('password')
		}, {
			success: options.success,
			error: options.error
		});
		turtl.api.post('/auth', {}, {
			success: options.success,
			error: options.error
		});
		turtl.api.clear_auth();
	}
});

// we don't actually use this collection for anything but syncing
var Users = Composer.Collection.extend({
	model: User,
	local_table: 'user',

	sync_record_from_db: function(userdata, msg)
	{
		if(!userdata) return false;
		if(turtl.sync.should_ignore([msg.sync_id], {type: 'local'})) return false;

		turtl.user.set(userdata);
	},

	sync_record_from_api: function(item)
	{
		// make sure item.key is set so the correct record updates in the DB
		// (since we only ever get one user object synced: ours)
		item.key = 'user';
		return this.parent.apply(this, arguments);
	}
});

